import { inspect, parseArgs } from "node:util";
import { CoAPClient, DEFAULT_PORT, type Status } from "./client.js";
import type { Logger } from "./coap.js";

const COMMANDS = ["status", "status-observe", "set"] as const;
type Command = (typeof COMMANDS)[number];
type ControlValue = string | number | boolean;

interface CliArgs {
  help: false;
  host: string;
  port: number;
  debug: boolean;
  command: Command;
  json: boolean;
  values: string[];
  valueAsInt: boolean;
}

export class UsageError extends Error {
  override name = "UsageError";
}

class InvalidValueError extends Error {
  override name = "InvalidValueError";
}

const MAX_PORT = 65535;
// Python's int() accepts surrounding whitespace, a sign and underscores between digits.
const INTEGER = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

const usage = (prog: string): string => `usage: ${prog} [-h] -H HOST [-P PORT] [-D] {${COMMANDS.join(",")}} ...

options:
  -h, --help            show this help message and exit
  -H, --host HOST       Address of CoAP-device
  -P, --port PORT       Port of CoAP-device (default: ${DEFAULT_PORT})
  -D, --debug           Enable debug output

commands:
  status [-J]           get status of device
  status-observe [-J]   Observe status of device
  set [-I] K=V [K=V ...]
                        Set value of device

command options:
  -J, --json            Output status as JSON (status, status-observe)
  -I, --int             Encode value as integer (set)`;

function parsePort(text: string | undefined): number {
  if (text === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > MAX_PORT) {
    throw new UsageError(`argument -P/--port: invalid port value: '${text}'`);
  }
  return port;
}

function isCommand(text: string): text is Command {
  return (COMMANDS as readonly string[]).includes(text);
}

function parseCommand(positionals: string[], json: boolean, valueAsInt: boolean): Command {
  const command = positionals[0];
  if (command === undefined) {
    throw new UsageError("the following arguments are required: command");
  }
  if (!isCommand(command)) {
    throw new UsageError(`argument command: invalid choice: '${command}' (choose from ${COMMANDS.join(", ")})`);
  }
  checkCommandArguments(command, positionals, json, valueAsInt);
  return command;
}

function checkCommandArguments(command: Command, positionals: string[], json: boolean, valueAsInt: boolean): void {
  if (command === "set") {
    if (json) {
      throw new UsageError(`-J/--json is not an option of '${command}'`);
    }
    if (positionals.length < 2) {
      throw new UsageError("the following arguments are required: K=V");
    }
  } else {
    if (valueAsInt) {
      throw new UsageError(`-I/--int is not an option of '${command}'`);
    }
    if (positionals.length > 1) {
      throw new UsageError(`unrecognized arguments: ${positionals.slice(1).join(" ")}`);
    }
  }
}

export function parseCliArgs(argv: string[]): CliArgs | { help: true } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        host: { type: "string", short: "H" },
        port: { type: "string", short: "P" },
        debug: { type: "boolean", short: "D" },
        json: { type: "boolean", short: "J" },
        int: { type: "boolean", short: "I" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    return { help: true };
  }
  if (values.host === undefined) {
    throw new UsageError("the following arguments are required: -H/--host");
  }
  const json = values.json === true;
  const valueAsInt = values.int === true;
  return {
    help: false,
    host: values.host,
    port: parsePort(values.port),
    debug: values.debug === true,
    command: parseCommand(positionals, json, valueAsInt),
    json,
    values: positionals.slice(1),
    valueAsInt,
  };
}

function parseValue(text: string, valueAsInt: boolean): ControlValue {
  // Booleans come before integers, so "true" and "false" stay booleans even with --int.
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (!valueAsInt) {
    return text;
  }
  if (!INTEGER.test(text)) {
    throw new InvalidValueError(`Cannot encode value '${text}' as int`);
  }
  return Number(text.replaceAll("_", ""));
}

/** Turn K=V arguments into control values. Only the first "=" separates the key from the value. */
export function parseValues(entries: string[], valueAsInt: boolean): Record<string, ControlValue> {
  const pairs = entries.map((entry): [string, ControlValue] => {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      throw new UsageError(`argument K=V: expected K=V, got '${entry}'`);
    }
    return [entry.slice(0, separator), parseValue(entry.slice(separator + 1), valueAsInt)];
  });
  return Object.fromEntries(pairs);
}

function formatStatus(status: Status, json: boolean): string {
  return json ? JSON.stringify(status) : inspect(status, { breakLength: Infinity, depth: null });
}

function cliLogger(debug: boolean): Logger {
  return {
    debug: debug ? (message) => console.error(`DEBUG: ${message}`) : () => {},
    error: (message) => console.error(`ERROR: ${message}`),
  };
}

async function run(client: CoAPClient, args: CliArgs, signal: AbortSignal): Promise<void> {
  switch (args.command) {
    case "status": {
      const { status, maxAge } = await client.getStatus({ signal });
      console.log(formatStatus(status, args.json));
      if (!args.json) {
        console.log(`max_age = ${maxAge}`);
      }
      return;
    }
    case "status-observe":
      for await (const status of client.observeStatus({ signal })) {
        console.log(formatStatus(status, args.json));
      }
      return;
    case "set": {
      let data;
      try {
        data = parseValues(args.values, args.valueAsInt);
      } catch (error) {
        if (!(error instanceof InvalidValueError)) {
          throw error;
        }
        console.log(error.message);
        return;
      }
      await client.setControlValues(data, { signal });
    }
  }
}

/** Run the command line and return the exit code. Ctrl+C stops the command and exits with code 0. */
export async function main(argv: string[], prog = "air-coap"): Promise<number> {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    console.error(`${usage(prog)}\n${prog}: error: ${error.message}`);
    return 2;
  }
  if (args.help) {
    console.log(usage(prog));
    return 0;
  }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  let client: CoAPClient | undefined;
  try {
    const logger = cliLogger(args.debug);
    client = await CoAPClient.create({ host: args.host, port: args.port, logger, signal: controller.signal });
    await run(client, args, controller.signal);
    return 0;
  } catch (error) {
    if (controller.signal.aborted) {
      return 0;
    }
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    await client?.shutdown();
  }
}
