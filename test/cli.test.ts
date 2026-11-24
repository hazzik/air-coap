import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseCliArgs, parseValues, UsageError } from "../src/cli.js";
import { FakeDevice } from "./fake-device.js";

describe("parseCliArgs", () => {
  it("parses the status command with defaults", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "status"])).toEqual({
      help: false,
      host: "192.168.1.1",
      port: 5683,
      debug: false,
      command: "status",
      json: false,
      values: [],
      valueAsInt: false,
    });
  });

  it("parses the JSON flag of status", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "status", "-J"])).toMatchObject({ json: true });
  });

  it("parses a custom port", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "-P", "1234", "status"])).toMatchObject({ port: 1234 });
  });

  it("parses the debug flag", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "-D", "status"])).toMatchObject({ debug: true });
  });

  it("parses the status-observe command", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "status-observe", "--json"])).toMatchObject({
      command: "status-observe",
      json: true,
    });
  });

  it("parses one value of set", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "set", "pwr=1"])).toMatchObject({ command: "set", values: ["pwr=1"] });
  });

  it("parses more values of set", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "set", "pwr=1", "mode=2"])).toMatchObject({
      values: ["pwr=1", "mode=2"],
    });
  });

  it("parses the int flag of set", () => {
    expect(parseCliArgs(["-H", "192.168.1.1", "set", "-I", "pwr=1"])).toMatchObject({ valueAsInt: true });
  });

  it("returns help for -h", () => {
    expect(parseCliArgs(["-h"])).toEqual({ help: true });
  });

  it.each([
    ["a missing host", ["status"]],
    ["a missing command", ["-H", "192.168.1.1"]],
    ["an unknown command", ["-H", "192.168.1.1", "reboot"]],
    ["set without values", ["-H", "192.168.1.1", "set"]],
    ["status with values", ["-H", "192.168.1.1", "status", "pwr=1"]],
    ["the JSON flag on set", ["-H", "192.168.1.1", "set", "-J", "pwr=1"]],
    ["the int flag on status", ["-H", "192.168.1.1", "status", "-I"]],
    ["a port that is not a number", ["-H", "192.168.1.1", "-P", "abc", "status"]],
    ["an unknown option", ["-H", "192.168.1.1", "--verbose", "status"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});

describe("parseValues", () => {
  it("keeps a string value", () => {
    expect(parseValues(["pwr=1"], false)).toEqual({ pwr: "1" });
  });

  it("parses true", () => {
    expect(parseValues(["active=true"], false)).toEqual({ active: true });
  });

  it("parses false", () => {
    expect(parseValues(["active=false"], false)).toEqual({ active: false });
  });

  it("parses an integer with --int", () => {
    expect(parseValues(["speed=3", "temp=-2", "big=1_000"], true)).toEqual({ speed: 3, temp: -2, big: 1000 });
  });

  it("keeps booleans with --int", () => {
    expect(parseValues(["pwr=true"], true)).toEqual({ pwr: true });
  });

  it("parses more values", () => {
    expect(parseValues(["pwr=1", "mode=2"], false)).toEqual({ pwr: "1", mode: "2" });
  });

  it("splits at the first equals sign only", () => {
    expect(parseValues(["filter=A=B"], false)).toEqual({ filter: "A=B" });
  });

  it("rejects a value that is not an integer with --int", () => {
    expect(() => parseValues(["pwr=on"], true)).toThrow("Cannot encode value 'on' as int");
  });

  it("rejects an argument without an equals sign", () => {
    expect(() => parseValues(["pwr"], false)).toThrow(UsageError);
  });

  it("stores __proto__ as a plain key", () => {
    const values = parseValues(["__proto__=x"], false);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.keys(values)).toEqual(["__proto__"]);
  });
});

describe("main", () => {
  let device: FakeDevice | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await device?.close();
    device = undefined;
  });

  async function run(...argv: string[]): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
    device ??= await FakeDevice.start({ maxAge: 30 });
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => stdout.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => stderr.push(line));
    const code = await main(["-H", "127.0.0.1", "-P", String(device.port), ...argv]);
    vi.restoreAllMocks();
    return { code, stdout, stderr };
  }

  it("prints the status as JSON", async () => {
    const { code, stdout } = await run("status", "--json");
    expect(code).toBe(0);
    expect(stdout.map((line) => JSON.parse(line) as unknown)).toEqual([device?.status]);
  });

  it("prints the status and the max age", async () => {
    const { code, stdout } = await run("status");
    expect(code).toBe(0);
    expect(stdout).toEqual(["{ name: 'Bedroom', pwr: '1', om: 'a', pm25: 4, rh: 52 }", "max_age = 30"]);
  });

  it("sets values", async () => {
    expect((await run("set", "-I", "om=2", "pwr=false")).code).toBe(0);
    expect((await run("set", "mode=AG")).code).toBe(0);
    expect(device?.status).toMatchObject({ om: 2, pwr: false, mode: "AG" });
  });

  it("prints an error and sends nothing for a value that is not an integer", async () => {
    const { code, stdout } = await run("set", "-I", "om=two");
    expect(code).toBe(0);
    expect(stdout).toEqual(["Cannot encode value 'two' as int"]);
    expect(device?.controls).toEqual([]);
  });

  it("prints debug messages with -D", async () => {
    const { stderr } = await run("-D", "status");
    expect(stderr).toContain("DEBUG: syncing");
    expect(stderr.some((line) => line.startsWith("DEBUG: sending NON GET"))).toBe(true);
  });

  it("prints the usage and returns 2 for a usage error", async () => {
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => stderr.push(line));
    expect(await main(["status"])).toBe(2);
    expect(stderr.join("\n")).toContain("air-coap: error: the following arguments are required: -H/--host");
  });

  it("uses the command name it gets in the usage and the error", async () => {
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => stderr.push(line));
    expect(await main(["status"], "aioairctrl")).toBe(2);
    expect(stderr.join("\n")).toMatch(/^usage: aioairctrl \[-h\]/);
    expect(stderr.join("\n")).toContain("\naioairctrl: error: the following arguments are required: -H/--host");
  });
});
