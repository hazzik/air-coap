/**
 * A fake Philips air purifier for tests. It answers the sync, status and control
 * requests of the encrypted CoAP protocol on a local UDP port.
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { once } from "node:events";
import { generate, parse, type NamedOption, type ParsedPacket } from "coap-packet";
import { EncryptionContext } from "../src/encryption.js";

export interface FakeDeviceOptions {
  /** Address to listen on. Defaults to 127.0.0.1. */
  address?: string;
  /** Value of the Max-Age option on status responses. No Max-Age option when undefined. */
  maxAge?: number;
  /** Add the Observe option to status responses. Defaults to true. */
  observable?: boolean;
  /** Send responses as confirmable messages. Defaults to false. */
  confirmable?: boolean;
  /** Split status payloads into blocks of 2^(blockSzx + 4) bytes. */
  blockSzx?: number;
}

interface Received {
  path: string;
  packet: ParsedPacket;
}

interface Observer {
  remote: RemoteInfo;
  token: Buffer;
  lastMessageId: number;
}

const CONTROL_FIELDS = new Set(["CommandType", "DeviceId", "EnduserId"]);
const MESSAGE_ID_MODULUS = 0x1_0000;
const LARGEST_UDP_PAYLOAD = 65_507;

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

function option(packet: ParsedPacket, name: string): Buffer | undefined {
  return packet.options.find((candidate) => candidate.name === name)?.value;
}

function hexKey(value: number): string {
  return value.toString(16).toUpperCase().padStart(8, "0");
}

export class FakeDevice {
  readonly acks: number[] = [];
  readonly resets: number[] = [];
  /** Decrypted plaintext of each control request. */
  readonly controls: string[] = [];
  readonly status: Record<string, unknown> = { name: "Bedroom", pwr: "1", om: "a", pm25: 4, rh: 52 };
  /** Paths that get no answer. */
  readonly ignored = new Set<string>();
  /** Paths answered with a reset message. */
  readonly resetPaths = new Set<string>();
  /** Answer every control request with a failure. */
  rejectControls = false;
  syncCount = 0;

  readonly #received: Received[] = [];
  readonly #socket: Socket;
  readonly #options: FakeDeviceOptions;
  readonly #observers = new Map<string, Observer>();
  readonly #encryption = new EncryptionContext();
  #counter = 0x0000_1000;
  #sequence = 1;
  #messageId = 40_000;
  #payload: Buffer = Buffer.alloc(0);

  private constructor(socket: Socket, options: FakeDeviceOptions) {
    this.#socket = socket;
    this.#options = options;
    this.#encryption.setClientKey("00000000");
    socket.on("message", (message, remote) => this.#receive(message, remote));
  }

  static async start(options: FakeDeviceOptions = {}): Promise<FakeDevice> {
    const address = options.address ?? "127.0.0.1";
    const socket = createSocket(address.includes(":") ? "udp6" : "udp4");
    socket.bind(0, address);
    await once(socket, "listening");
    return new FakeDevice(socket, options);
  }

  get port(): number {
    return this.#socket.address().port;
  }

  get observerCount(): number {
    return this.#observers.size;
  }

  requests(path: string): ParsedPacket[] {
    return this.#received.filter((entry) => entry.path === path).map((entry) => entry.packet);
  }

  /** Change the expected client key, as a device restart does. */
  changeKey(): void {
    this.#counter += 0x1000;
  }

  /** Send the current status to every observer. */
  notify(sequence = this.#sequence + 1): void {
    this.#sequence = sequence;
    this.#payload = this.#encryptStatus();
    for (const observer of this.#observers.values()) {
      observer.lastMessageId = this.#sendStatus(observer.remote, observer.token, sequence, 0);
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#socket.close(resolve));
  }

  #receive(message: Buffer, remote: RemoteInfo): void {
    const packet = parse(message);
    if (packet.code === "0.00") {
      this.#receiveEmpty(packet);
      return;
    }
    const path = packet.options
      .filter((candidate) => candidate.name === "Uri-Path")
      .map((candidate) => candidate.value.toString("utf8"))
      .join("/");
    this.#received.push({ path, packet });
    if (this.ignored.has(path)) {
      return;
    }
    if (this.resetPaths.has(path)) {
      this.#socket.send(
        generate({ code: "0.00", reset: true, messageId: packet.messageId }),
        remote.port,
        remote.address,
      );
      return;
    }
    this.#handle(path, packet, remote);
  }

  #receiveEmpty(packet: ParsedPacket): void {
    if (packet.ack) {
      this.acks.push(packet.messageId);
    }
    if (packet.reset) {
      this.resets.push(packet.messageId);
      for (const [key, observer] of this.#observers) {
        if (observer.lastMessageId === packet.messageId) {
          this.#observers.delete(key);
        }
      }
    }
  }

  #handle(path: string, packet: ParsedPacket, remote: RemoteInfo): void {
    switch (path) {
      case "sys/dev/sync":
        this.syncCount += 1;
        this.#respond(remote, packet.token, "2.05", Buffer.from(hexKey(this.#counter)), []);
        return;
      case "sys/dev/status":
        this.#handleStatus(packet, remote);
        return;
      case "sys/dev/control":
        this.#handleControl(packet, remote);
        return;
      default:
        this.#respond(remote, packet.token, "4.04", Buffer.alloc(0), []);
    }
  }

  #handleStatus(packet: ParsedPacket, remote: RemoteInfo): void {
    const block2 = option(packet, "Block2");
    if (block2 !== undefined) {
      this.#sendStatus(remote, packet.token, undefined, Math.floor(decodeUint(block2) / 16));
      return;
    }
    this.#payload = this.#encryptStatus();
    const observe = option(packet, "Observe");
    const registers = observe !== undefined && decodeUint(observe) === 0 && this.#options.observable !== false;
    const messageId = this.#sendStatus(remote, packet.token, registers ? this.#sequence : undefined, 0);
    if (registers) {
      this.#observers.set(packet.token.toString("hex"), { remote, token: packet.token, lastMessageId: messageId });
    }
  }

  #handleControl(packet: ParsedPacket, remote: RemoteInfo): void {
    const encrypted = packet.payload.toString("utf8");
    const plaintext = new EncryptionContext().decrypt(encrypted);
    this.controls.push(plaintext);
    const accepted = !this.rejectControls && encrypted.slice(0, 8) === hexKey(this.#counter + 1);
    if (accepted) {
      this.#counter += 1;
      const desired = (JSON.parse(plaintext) as { state: { desired: Record<string, unknown> } }).state.desired;
      for (const [key, value] of Object.entries(desired)) {
        if (!CONTROL_FIELDS.has(key)) {
          this.status[key] = value;
        }
      }
    }
    const result = JSON.stringify({ status: accepted ? "success" : "failed" });
    this.#respond(remote, packet.token, "2.04", Buffer.from(result), []);
    if (accepted) {
      this.notify();
    }
  }

  #encryptStatus(): Buffer {
    return Buffer.from(this.#encryption.encrypt(JSON.stringify({ state: { reported: this.status, desired: null } })));
  }

  #sendStatus(remote: RemoteInfo, token: Buffer, observe: number | undefined, blockNum: number): number {
    const options: NamedOption[] = [];
    if (observe !== undefined) {
      options.push({ name: "Observe", value: encodeUint(observe) });
    }
    if (this.#options.maxAge !== undefined) {
      options.push({ name: "Max-Age", value: encodeUint(this.#options.maxAge) });
    }
    let payload = this.#payload;
    const szx = this.#options.blockSzx;
    if (szx !== undefined) {
      const size = 2 ** (szx + 4);
      const start = blockNum * size;
      const more = start + size < payload.length;
      payload = payload.subarray(start, start + size);
      options.push({ name: "Block2", value: encodeUint(blockNum * 16 + (more ? 8 : 0) + szx) });
    }
    return this.#respond(remote, token, "2.05", payload, options);
  }

  #respond(remote: RemoteInfo, token: Buffer, code: string, payload: Buffer, options: NamedOption[]): number {
    this.#messageId = (this.#messageId + 1) % MESSAGE_ID_MODULUS;
    const packet = {
      code,
      confirmable: this.#options.confirmable === true,
      messageId: this.#messageId,
      token,
      options,
      payload,
    };
    this.#socket.send(generate(packet, LARGEST_UDP_PAYLOAD), remote.port, remote.address);
    return this.#messageId;
  }
}
