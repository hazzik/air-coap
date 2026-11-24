/**
 * Minimal CoAP (RFC 7252) client endpoint over UDP for one remote device.
 *
 * It sends every request as non-confirmable (NON), matches responses by token,
 * acknowledges confirmable responses, supports observation (RFC 7641) and
 * reassembles block-wise responses (RFC 7959, Block2 only).
 * Requests have no timeout; cancel them with an AbortSignal or by closing the endpoint.
 */
import { randomInt } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { isIP } from "node:net";
import { generate, parse, type NamedOption, type OptionName, type Packet, type ParsedPacket } from "coap-packet";

type Method = "GET" | "POST";

export interface Logger {
  debug(message: string): void;
  error(message: string): void;
}

export interface CoapResponse {
  payload: Buffer;
  /** Value of the Max-Age option, undefined if the response has none. */
  maxAge: number | undefined;
}

interface RequestOptions {
  payload?: string;
  /** Register an observation (Observe: 0) and resolve with the first response only. */
  observe?: boolean;
  signal?: AbortSignal;
}

export class ShutdownError extends Error {
  override name = "ShutdownError";

  constructor() {
    super("CoAP endpoint is closed");
  }
}

export class ResetError extends Error {
  override name = "ResetError";

  constructor() {
    super("device rejected the request with a reset message");
  }
}

export class NotObservableError extends Error {
  override name = "NotObservableError";

  constructor() {
    super("device sent a response without the Observe option, so the observation has ended");
  }
}

interface Exchange {
  messageId: number;
  queue: PacketQueue;
}

interface StartedExchange {
  packet: Packet;
  queue: PacketQueue;
  /** Forget the token and stop listening for the abort signal. */
  end(): void;
}

interface Block {
  num: number;
  more: boolean;
  size: number;
  szx: number;
}

interface Observed {
  sequence: number;
  time: number;
}

const MESSAGE_ID_MODULUS = 0x1_0000;
// RFC 7641 section 3.4: a notification is newer if its sequence number is ahead by less than 2^23,
// or if it arrives more than 128 seconds after the previous one.
const OBSERVE_WINDOW = 2 ** 23;
const OBSERVE_TIMEOUT_MS = 128_000;
// RFC 7959 section 2.2: SZX 7 is reserved.
const MAX_SZX = 6;

function encodeUint(value: number): Buffer {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from(bytes);
}

function decodeUint(value: Buffer): number {
  return value.reduce((result, byte) => result * 256 + byte, 0);
}

function findOption(packet: ParsedPacket, name: OptionName): Buffer | undefined {
  return packet.options.find((option) => option.name === name)?.value;
}

function uintOption(packet: ParsedPacket, name: OptionName): number | undefined {
  const value = findOption(packet, name);
  return value === undefined ? undefined : decodeUint(value);
}

function readBlock2(packet: ParsedPacket): Block | undefined {
  const raw = uintOption(packet, "Block2");
  if (raw === undefined) {
    return undefined;
  }
  const szx = raw & 0b111;
  if (szx > MAX_SZX) {
    throw new Error(`response uses the reserved Block2 size exponent ${szx}`);
  }
  return { num: Math.floor(raw / 16), more: (raw & 0b1000) !== 0, size: 2 ** (szx + 4), szx };
}

function encodeBlock2(num: number, szx: number): Buffer {
  return encodeUint(num * 16 + szx);
}

function toResponse(packet: ParsedPacket, payload = packet.payload): CoapResponse {
  return { payload, maxAge: uintOption(packet, "Max-Age") };
}

function isNewer(previous: Observed, sequence: number, time: number): boolean {
  return (
    (previous.sequence < sequence && sequence - previous.sequence < OBSERVE_WINDOW) ||
    (previous.sequence > sequence && previous.sequence - sequence > OBSERVE_WINDOW) ||
    time > previous.time + OBSERVE_TIMEOUT_MS
  );
}

function messageType(packet: Packet): string {
  if (packet.ack === true) {
    return "ACK";
  }
  if (packet.reset === true) {
    return "RST";
  }
  return packet.confirmable === true ? "CON" : "NON";
}

function describeOption(option: { name: string | number; value: Buffer }): string {
  const text = option.name === "Uri-Path" || option.name === "Uri-Host";
  return `${option.name}=${text ? option.value.toString("utf8") : decodeUint(option.value)}`;
}

function describe(packet: Packet): string {
  const options = (packet.options ?? []).map(describeOption).join(" ");
  const token = packet.token?.toString("hex") ?? "";
  const payloadLength = packet.payload?.length ?? 0;
  return `${messageType(packet)} ${packet.code} mid=${packet.messageId} token=${token} ${options} (${payloadLength} byte payload)`;
}

/** Packets of one exchange, read in arrival order. A failure ends reading at once. */
class PacketQueue {
  #packets: ParsedPacket[] = [];
  #failure: Error | undefined;
  #wake: (() => void) | undefined;

  push(packet: ParsedPacket): void {
    this.#packets.push(packet);
    this.#notify();
  }

  fail(error: Error): void {
    this.#failure ??= error;
    this.#notify();
  }

  async next(): Promise<ParsedPacket> {
    for (;;) {
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      const packet = this.#packets.shift();
      if (packet !== undefined) {
        return packet;
      }
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

export class CoapEndpoint {
  readonly #socket: Socket;
  readonly #address: string;
  readonly #port: number;
  readonly #uriHost: string | undefined;
  readonly #logger: Logger;
  readonly #exchanges = new Map<string, Exchange>();
  #messageId = randomInt(MESSAGE_ID_MODULUS);
  #token = randomInt(MESSAGE_ID_MODULUS);
  #closed = false;

  private constructor(socket: Socket, address: string, port: number, uriHost: string | undefined, logger: Logger) {
    this.#socket = socket;
    this.#address = address;
    this.#port = port;
    this.#uriHost = uriHost;
    this.#logger = logger;
    socket.on("message", (message, remote) => this.#receive(message, remote));
    socket.on("error", (error) => {
      this.#logger.error(`CoAP socket error: ${error.message}`);
      this.#failAll(error);
    });
  }

  static async open(host: string, port: number, logger: Logger): Promise<CoapEndpoint> {
    const { address, family } = await lookup(host);
    const socket = createSocket(family === 6 ? "udp6" : "udp4");
    socket.bind();
    await once(socket, "listening");
    // Like aiocoap, send Uri-Host only when the host is a name and not an IP literal.
    const uriHost = isIP(host) === 0 ? host.toLowerCase() : undefined;
    return new CoapEndpoint(socket, address, port, uriHost, logger);
  }

  async request(method: Method, path: string, options: RequestOptions = {}): Promise<CoapResponse> {
    const first = await this.#exchange(method, path, options);
    return this.#completeBlockwise(method, path, options, first);
  }

  /**
   * Register an observation and yield the first response and every newer notification.
   * Stopping the iteration forgets the token: the endpoint then ignores non-confirmable notifications
   * and rejects confirmable ones with a reset message.
   */
  async *observe(path: string, signal?: AbortSignal): AsyncGenerator<CoapResponse, void, undefined> {
    const options = { observe: true, signal };
    const exchange = this.#start("GET", path, options);
    try {
      await this.#send(exchange.packet);
      let previous: Observed | undefined;
      for (;;) {
        const received = await exchange.queue.next();
        const sequence = uintOption(received, "Observe");
        const time = Date.now();
        if (previous !== undefined && sequence !== undefined && !isNewer(previous, sequence, time)) {
          continue;
        }
        yield await this.#completeBlockwise("GET", path, options, received);
        if (sequence === undefined) {
          throw new NotObservableError();
        }
        previous = { sequence, time };
      }
    } finally {
      exchange.end();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#failAll(new ShutdownError());
    await new Promise<void>((resolve) => this.#socket.close(resolve));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ShutdownError();
    }
  }

  /** Register a token and build its request packet. Responses, a reset and an abort all go to the queue. */
  #start(method: Method, path: string, options: RequestOptions, block2?: Buffer): StartedExchange {
    const { signal } = options;
    signal?.throwIfAborted();
    this.#assertOpen();
    this.#messageId = (this.#messageId + 1) % MESSAGE_ID_MODULUS;
    this.#token += 1;
    const token = encodeUint(this.#token);
    const key = token.toString("hex");
    const queue = new PacketQueue();
    this.#exchanges.set(key, { messageId: this.#messageId, queue });
    const onAbort = () => queue.fail(signal?.reason as Error);
    signal?.addEventListener("abort", onAbort, { once: true });
    const packet: Packet = {
      code: method,
      confirmable: false,
      messageId: this.#messageId,
      token,
      options: this.#options(path, options.observe === true, block2),
      payload: Buffer.from(options.payload ?? "", "utf8"),
    };
    const end = () => {
      this.#exchanges.delete(key);
      signal?.removeEventListener("abort", onAbort);
    };
    return { packet, queue, end };
  }

  async #exchange(method: Method, path: string, options: RequestOptions, block2?: Buffer): Promise<ParsedPacket> {
    const exchange = this.#start(method, path, options, block2);
    try {
      await this.#send(exchange.packet);
      return await exchange.queue.next();
    } finally {
      exchange.end();
    }
  }

  async #completeBlockwise(
    method: Method,
    path: string,
    options: RequestOptions,
    first: ParsedPacket,
  ): Promise<CoapResponse> {
    let block = readBlock2(first);
    if (block?.more !== true) {
      return toResponse(first);
    }
    const parts: Buffer[] = [];
    let received = first;
    let offset = 0;
    for (;;) {
      if (block === undefined || block.num * block.size !== offset) {
        throw new Error(`device sent a block that does not start at offset ${offset}`);
      }
      parts.push(received.payload);
      offset += received.payload.length;
      if (!block.more) {
        return toResponse(first, Buffer.concat(parts));
      }
      if (offset % block.size !== 0) {
        throw new Error(`device sent a block shorter than ${block.size} bytes before the last block`);
      }
      received = await this.#exchange(method, path, options, encodeBlock2(offset / block.size, block.szx));
      block = readBlock2(received);
    }
  }

  #options(path: string, observe: boolean, block2: Buffer | undefined): NamedOption[] {
    const options: NamedOption[] = [];
    if (this.#uriHost !== undefined) {
      options.push({ name: "Uri-Host", value: Buffer.from(this.#uriHost, "utf8") });
    }
    // A request for a later block fetches the rest of a response, so it does not register an observation.
    if (observe && block2 === undefined) {
      options.push({ name: "Observe", value: encodeUint(0) });
    }
    for (const segment of path.split("/").filter((part) => part !== "")) {
      options.push({ name: "Uri-Path", value: Buffer.from(segment, "utf8") });
    }
    if (block2 !== undefined) {
      options.push({ name: "Block2", value: block2 });
    }
    return options;
  }

  #send(packet: Packet): Promise<void> {
    const buffer = generate(packet);
    this.#logger.debug(`sending ${describe(packet)}`);
    return new Promise((resolve, reject) => {
      this.#socket.send(buffer, this.#port, this.#address, (error) => (error ? reject(error) : resolve()));
    });
  }

  #reply(packet: ParsedPacket, type: "ack" | "reset"): void {
    const reply: Packet = { code: "0.00", messageId: packet.messageId, [type]: true };
    this.#send(reply).catch((error: unknown) => this.#logger.debug(`sending ${type} failed: ${String(error)}`));
  }

  #receive(message: Buffer, remote: RemoteInfo): void {
    if (remote.address !== this.#address || remote.port !== this.#port) {
      return;
    }
    let packet: ParsedPacket;
    try {
      packet = parse(message);
    } catch {
      this.#logger.debug(`ignoring a malformed packet of ${message.length} bytes`);
      return;
    }
    this.#logger.debug(`received ${describe(packet)}`);
    if (packet.code === "0.00") {
      this.#receiveEmpty(packet);
    } else if (!packet.code.startsWith("0.")) {
      this.#receiveResponse(packet);
    }
  }

  #receiveEmpty(packet: ParsedPacket): void {
    if (packet.reset) {
      const exchange = [...this.#exchanges.values()].find((candidate) => candidate.messageId === packet.messageId);
      exchange?.queue.fail(new ResetError());
    } else if (packet.confirmable) {
      // RFC 7252 section 4.3: answer a CoAP ping with a reset message.
      this.#reply(packet, "reset");
    }
  }

  #receiveResponse(packet: ParsedPacket): void {
    const exchange = this.#exchanges.get(packet.token.toString("hex"));
    if (exchange === undefined) {
      // Like aiocoap, reject an unknown confirmable response and ignore an unknown non-confirmable one.
      if (packet.confirmable) {
        this.#reply(packet, "reset");
      }
      return;
    }
    if (packet.confirmable) {
      this.#reply(packet, "ack");
    }
    exchange.queue.push(packet);
  }

  #failAll(error: Error): void {
    for (const exchange of this.#exchanges.values()) {
      exchange.queue.fail(error);
    }
  }
}
