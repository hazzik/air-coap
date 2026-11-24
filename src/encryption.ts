/**
 * Encryption used by the Philips air purifier CoAP protocol.
 *
 * Wire format for an encrypted payload (all hex-encoded, uppercase ASCII):
 *
 *     [client_key: 8 chars][ciphertext: variable][sha256_digest: 64 chars]
 *
 * The client key embedded in the payload is a 4-byte big-endian counter
 * (incremented before each encrypt call) expressed as 8 hex characters.
 *
 * Key derivation: MD5("JiangPan" + client_key) as uppercase hex, split into two equal halves.
 * The ASCII bytes of the first half are the AES-128 key, the ASCII bytes of the second half the CBC IV.
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

const KEY_LENGTH = 8;
const DIGEST_LENGTH = 64;
const COUNTER_MODULUS = 0x1_0000_0000n;
const HEX = /^[0-9A-Fa-f]*$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class DigestMismatchError extends Error {
  override name = "DigestMismatchError";

  constructor() {
    super("payload digest does not match its content");
  }
}

function hex(value: string, algorithm: "md5" | "sha256"): string {
  return createHash(algorithm).update(value).digest("hex").toUpperCase();
}

function keyAndIv(key: string): [Buffer, Buffer] {
  const derived = hex(EncryptionContext.SECRET_KEY + key, "md5");
  const half = derived.length / 2;
  return [Buffer.from(derived.slice(0, half), "ascii"), Buffer.from(derived.slice(half), "ascii")];
}

export class EncryptionContext {
  /** Protocol-defined secret mixed into every key derivation. */
  static readonly SECRET_KEY = "JiangPan";

  /** Hex-encoded 4-byte counter, e.g. "00A3F1C2". Undefined until `setClientKey` is called. */
  #clientKey: string | undefined;

  get clientKey(): string | undefined {
    return this.#clientKey;
  }

  setClientKey(clientKey: string): void {
    this.#clientKey = clientKey;
  }

  #incrementClientKey(): string {
    const current = this.#clientKey?.trim();
    if (current === undefined) {
      throw new Error("Client key must be set before incrementing");
    }
    if (current === "" || !HEX.test(current)) {
      throw new Error(`Client key is not hexadecimal: ${current}`);
    }
    // Wrap around at 0xFFFFFFFF so the counter stays within 4 bytes.
    const next = (BigInt(`0x${current}`) + 1n) % COUNTER_MODULUS;
    this.#clientKey = next.toString(16).toUpperCase().padStart(KEY_LENGTH, "0");
    return this.#clientKey;
  }

  encrypt(payload: string): string {
    // Increment first so the key embedded in the output is always ahead of
    // the last key seen by the device, preventing replay of old counters.
    const key = this.#incrementClientKey();
    const cipher = createCipheriv("aes-128-cbc", ...keyAndIv(key));
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()])
      .toString("hex")
      .toUpperCase();
    // Integrity check: SHA-256 over (key + ciphertext) appended at the end.
    return key + ciphertext + hex(key + ciphertext, "sha256");
  }

  decrypt(payloadEncrypted: string): string {
    const key = payloadEncrypted.slice(0, KEY_LENGTH);
    const ciphertext = payloadEncrypted.slice(KEY_LENGTH, -DIGEST_LENGTH);
    const digest = payloadEncrypted.slice(-DIGEST_LENGTH);
    if (digest !== hex(key + ciphertext, "sha256")) {
      throw new DigestMismatchError();
    }
    if (ciphertext.length % 2 !== 0 || !HEX.test(ciphertext)) {
      throw new Error("ciphertext is not hexadecimal");
    }
    const decipher = createDecipheriv("aes-128-cbc", ...keyAndIv(key));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]);
    return UTF8_DECODER.decode(plaintext);
  }
}
