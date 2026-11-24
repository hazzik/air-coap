/** CoAP client for Philips air purifiers. */
import { randomBytes } from "node:crypto";
import { CoapEndpoint, type CoapResponse, type Logger } from "./coap.js";
import { EncryptionContext } from "./encryption.js";
import { pythonJsonDumps, type JsonValue } from "./json.js";

export type Status = Record<string, JsonValue>;

export interface ClientOptions {
  host: string;
  /** Defaults to 5683, the CoAP port. */
  port?: number;
  /** Receives debug messages and errors. By default debug messages are dropped and errors go to `console.error`. */
  logger?: Logger;
  /** Cancels the initial key exchange. */
  signal?: AbortSignal;
}

export interface StatusOptions {
  signal?: AbortSignal;
}

export interface ControlOptions {
  /** Number of retries after the first attempt. Defaults to 5. */
  retryCount?: number;
  /** Exchange the client key again after the first failed attempt. Defaults to true. */
  resync?: boolean;
  signal?: AbortSignal;
}

export interface StatusResult {
  status: Status;
  /** Seconds the status stays fresh, from the response's Max-Age option. */
  maxAge: number;
}

export const DEFAULT_PORT = 5683;
// RFC 7252 section 5.10.5: a response without the Max-Age option is fresh for 60 seconds.
const DEFAULT_MAX_AGE = 60;
const DEFAULT_RETRY_COUNT = 5;
const SYNC_REQUEST_BYTES = 4;

const defaultLogger: Logger = {
  debug: () => {},
  error: (message) => console.error(message),
};

function isSuccess(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as Record<string, unknown>).status === "success";
}

export class CoAPClient {
  static readonly STATUS_PATH = "/sys/dev/status";
  static readonly CONTROL_PATH = "/sys/dev/control";
  static readonly SYNC_PATH = "/sys/dev/sync";

  readonly host: string;
  readonly port: number;
  readonly #endpoint: CoapEndpoint;
  readonly #encryption = new EncryptionContext();
  readonly #logger: Logger;

  private constructor(host: string, port: number, endpoint: CoapEndpoint, logger: Logger) {
    this.host = host;
    this.port = port;
    this.#endpoint = endpoint;
    this.#logger = logger;
  }

  /** Open a client and exchange the initial client key with the device. */
  static async create({
    host,
    port = DEFAULT_PORT,
    logger = defaultLogger,
    signal,
  }: ClientOptions): Promise<CoAPClient> {
    const endpoint = await CoapEndpoint.open(host, port, logger);
    const client = new CoAPClient(host, port, endpoint, logger);
    try {
      await client.#sync(signal);
    } catch (error) {
      await endpoint.close();
      throw error;
    }
    return client;
  }

  /** Close the socket. Pending requests and observations fail with `ShutdownError`. */
  async shutdown(): Promise<void> {
    await this.#endpoint.close();
  }

  /**
   * Exchange a nonce with the device to obtain the initial client key.
   *
   * The client sends a random 4-byte hex string; the device responds with
   * the client key that must be used for all subsequent encrypted messages.
   */
  async #sync(signal: AbortSignal | undefined): Promise<void> {
    this.#logger.debug("syncing");
    const syncRequest = randomBytes(SYNC_REQUEST_BYTES).toString("hex").toUpperCase();
    const response = await this.#endpoint.request("POST", CoAPClient.SYNC_PATH, { payload: syncRequest, signal });
    const clientKey = response.payload.toString("utf8");
    this.#logger.debug(`synced: ${clientKey}`);
    this.#encryption.setClientKey(clientKey);
  }

  /** Return the current device status and the number of seconds it stays fresh. */
  async getStatus({ signal }: StatusOptions = {}): Promise<StatusResult> {
    this.#logger.debug("retrieving status");
    // Observe: 0 registers an observation; the first response carries the current state, which is all this reads.
    const response = await this.#endpoint.request("GET", CoAPClient.STATUS_PATH, { observe: true, signal });
    const status = this.#reported(response, "status");
    let maxAge = DEFAULT_MAX_AGE;
    if (response.maxAge !== undefined) {
      maxAge = response.maxAge;
      this.#logger.debug(`max age = ${maxAge}`);
    }
    return { status, maxAge };
  }

  /** Yield the current status, then each status the device pushes, until the caller stops iterating. */
  async *observeStatus({ signal }: StatusOptions = {}): AsyncGenerator<Status, void, undefined> {
    this.#logger.debug("observing status");
    for await (const response of this.#endpoint.observe(CoAPClient.STATUS_PATH, signal)) {
      yield this.#reported(response, "observation status");
    }
  }

  #reported(response: CoapResponse, label: string): Status {
    const payload = this.#encryption.decrypt(response.payload.toString("utf8"));
    this.#logger.debug(`${label}: ${payload}`);
    return (JSON.parse(payload) as { state: { reported: Status } }).state.reported;
  }

  setControlValue(key: string, value: JsonValue, options?: ControlOptions): Promise<boolean> {
    return this.setControlValues({ [key]: value }, options);
  }

  /**
   * Send a control command to the device, retrying on failure.
   *
   * On the first failure, if `resync` is true, the client exchanges the
   * client key again before retrying. Later failures retry without
   * exchanging the key again.
   */
  async setControlValues(
    data: Record<string, JsonValue>,
    { retryCount = DEFAULT_RETRY_COUNT, resync = true, signal }: ControlOptions = {},
  ): Promise<boolean> {
    const stateDesired = { state: { desired: { CommandType: "app", DeviceId: "", EnduserId: "", ...data } } };
    const payload = pythonJsonDumps(stateDesired);
    this.#logger.debug(`REQUEST: ${payload}`);
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      const payloadEncrypted = this.#encryption.encrypt(payload);
      const response = await this.#endpoint.request("POST", CoAPClient.CONTROL_PATH, {
        payload: payloadEncrypted,
        signal,
      });
      const text = response.payload.toString("utf8");
      this.#logger.debug(`RESPONSE: ${text}`);
      if (isSuccess(JSON.parse(text))) {
        return true;
      }
      if (attempt === 0 && resync) {
        this.#logger.debug("setControlValues failed, resyncing...");
        await this.#sync(signal);
      } else {
        this.#logger.debug(`setControlValues failed, retrying (attempt ${attempt + 1}/${retryCount})...`);
      }
    }
    this.#logger.error(`setControlValues failed: ${JSON.stringify(data)}`);
    return false;
  }
}
