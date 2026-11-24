import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoAPClient, NotObservableError, ResetError, ShutdownError, type Logger } from "../src/index.js";
import { FakeDevice, type FakeDeviceOptions } from "./fake-device.js";

let device: FakeDevice | undefined;
let client: CoAPClient | undefined;

async function connect(
  options: FakeDeviceOptions = {},
  logger?: Logger,
): Promise<{ device: FakeDevice; client: CoAPClient }> {
  device = await FakeDevice.start(options);
  client = await CoAPClient.create({ host: options.address ?? "127.0.0.1", port: device.port, logger });
  return { device, client };
}

function option(device: FakeDevice, path: string, index: number, name: string): string | undefined {
  const request = device.requests(path)[index];
  return request?.options
    .filter((candidate) => candidate.name === name)
    .map((candidate) => candidate.value.toString("hex"))
    .join(",");
}

afterEach(async () => {
  await client?.shutdown();
  await device?.close();
  client = undefined;
  device = undefined;
});

describe("CoAPClient.create", () => {
  it("exchanges the client key with a non-confirmable POST", async () => {
    const { device } = await connect();
    expect(device.syncCount).toBe(1);
    const [sync] = device.requests("sys/dev/sync");
    expect(sync?.code).toBe("0.02");
    expect(sync?.confirmable).toBe(false);
    expect(sync?.payload.toString()).toMatch(/^[0-9A-F]{8}$/);
    expect(option(device, "sys/dev/sync", 0, "Uri-Host")).toBe("");
  });

  it("sends Uri-Host when the host is a name", async () => {
    const { address } = await lookup("localhost");
    const { device } = await connect({ address });
    await client?.shutdown();
    client = await CoAPClient.create({ host: "localhost", port: device.port });
    expect(option(device, "sys/dev/sync", 1, "Uri-Host")).toBe(Buffer.from("localhost").toString("hex"));
  });

  it("fails when the signal aborts the key exchange", async () => {
    device = await FakeDevice.start();
    device.ignored.add("sys/dev/sync");
    const controller = new AbortController();
    const created = CoAPClient.create({ host: "127.0.0.1", port: device.port, signal: controller.signal });
    await vi.waitFor(() => expect(device?.requests("sys/dev/sync")).toHaveLength(1));
    controller.abort();
    await expect(created).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("getStatus", () => {
  it("returns the reported state and the default max age of 60 seconds", async () => {
    const { device, client } = await connect();
    const result = await client.getStatus();
    expect(result).toEqual({ status: device.status, maxAge: 60 });
    const [request] = device.requests("sys/dev/status");
    expect(request?.code).toBe("0.01");
    expect(option(device, "sys/dev/status", 0, "Observe")).toBe("");
  });

  it("reads the max age from the Max-Age option", async () => {
    const { client } = await connect({ maxAge: 15 });
    expect((await client.getStatus()).maxAge).toBe(15);
  });

  it("acknowledges a confirmable response and resets a later notification", async () => {
    const { device, client } = await connect({ confirmable: true });
    await client.getStatus();
    await vi.waitFor(() => expect(device.acks).toHaveLength(2));
    device.notify();
    await vi.waitFor(() => expect(device.resets).toHaveLength(1));
    expect(device.observerCount).toBe(0);
  });

  it("ignores a later non-confirmable notification", async () => {
    const { device, client } = await connect();
    await client.getStatus();
    device.notify();
    await client.getStatus();
    expect(device.resets).toEqual([]);
  });

  it("reassembles a block-wise response", async () => {
    const { device, client } = await connect({ blockSzx: 2 });
    const { status } = await client.getStatus();
    expect(status).toEqual(device.status);
    const blocks = device.requests("sys/dev/status").length;
    expect(blocks).toBeGreaterThan(2);
    expect(option(device, "sys/dev/status", blocks - 1, "Observe")).toBe("");
  });

  it("fails with ShutdownError when the client shuts down", async () => {
    const { device, client } = await connect();
    device.ignored.add("sys/dev/status");
    const pending = client.getStatus();
    await vi.waitFor(() => expect(device.requests("sys/dev/status")).toHaveLength(1));
    await client.shutdown();
    await expect(pending).rejects.toBeInstanceOf(ShutdownError);
  });

  it("fails with the abort reason when the signal aborts", async () => {
    const { device, client } = await connect();
    device.ignored.add("sys/dev/status");
    const controller = new AbortController();
    const pending = client.getStatus({ signal: controller.signal });
    await vi.waitFor(() => expect(device.requests("sys/dev/status")).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("observeStatus", () => {
  it("yields the current status and each pushed update", async () => {
    const { client } = await connect();
    const seen: unknown[] = [];
    for await (const status of client.observeStatus()) {
      seen.push(status.pwr);
      if (seen.length === 1) {
        await client.setControlValue("pwr", "0");
      } else {
        break;
      }
    }
    expect(seen).toEqual(["1", "0"]);
  });

  it("skips a notification older than the last one", async () => {
    const { device, client } = await connect();
    const seen: unknown[] = [];
    for await (const status of client.observeStatus()) {
      seen.push(status.pm25);
      if (seen.length === 1) {
        for (const [pm25, sequence] of [
          [10, 10],
          [5, 5],
          [11, 11],
        ]) {
          device.status.pm25 = pm25;
          device.notify(sequence);
        }
      }
      if (seen.length === 3) {
        break;
      }
    }
    expect(seen).toEqual([4, 10, 11]);
  });

  it("resets a confirmable notification after the caller stops iterating", async () => {
    const { device, client } = await connect({ confirmable: true });
    for await (const status of client.observeStatus()) {
      expect(status).toEqual(device.status);
      break;
    }
    device.notify();
    await vi.waitFor(() => expect(device.resets).toHaveLength(1));
  });

  it("reassembles a block-wise notification", async () => {
    const { device, client } = await connect({ blockSzx: 3 });
    const observation = client.observeStatus();
    expect((await observation.next()).value).toEqual(device.status);
    device.status.pm25 = 42;
    device.notify();
    expect((await observation.next()).value).toEqual(device.status);
    await observation.return();
  });

  it("fails with NotObservableError after a response without the Observe option", async () => {
    const { device, client } = await connect({ observable: false });
    const observation = client.observeStatus();
    expect((await observation.next()).value).toEqual(device.status);
    await expect(observation.next()).rejects.toBeInstanceOf(NotObservableError);
  });

  it("fails with ShutdownError when the client shuts down", async () => {
    const { client } = await connect();
    const observation = client.observeStatus();
    await observation.next();
    const pending = observation.next();
    await client.shutdown();
    await expect(pending).rejects.toBeInstanceOf(ShutdownError);
  });
});

describe("setControlValues", () => {
  it("sends the desired state and returns true", async () => {
    const { device, client } = await connect();
    expect(await client.setControlValues({ pwr: "0", om: 2 })).toBe(true);
    expect(device.controls).toEqual([
      '{"state": {"desired": {"CommandType": "app", "DeviceId": "", "EnduserId": "", "pwr": "0", "om": 2}}}',
    ]);
    expect(device.status).toMatchObject({ pwr: "0", om: 2 });
  });

  it("exchanges the client key again after the first failure", async () => {
    const { device, client } = await connect();
    device.changeKey();
    expect(await client.setControlValue("pwr", "0")).toBe(true);
    expect(device.syncCount).toBe(2);
    expect(device.controls).toHaveLength(2);
  });

  it("returns false and logs an error after the last retry", async () => {
    const logger = { debug: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() };
    const { device, client } = await connect({}, logger);
    device.rejectControls = true;
    expect(await client.setControlValues({ pwr: "0" }, { retryCount: 2 })).toBe(false);
    expect(device.controls).toHaveLength(3);
    expect(device.syncCount).toBe(2);
    expect(logger.error).toHaveBeenCalledWith('setControlValues failed: {"pwr":"0"}');
  });

  it("does not exchange the key again when resync is false", async () => {
    const { device, client } = await connect();
    device.rejectControls = true;
    expect(await client.setControlValues({ pwr: "0" }, { retryCount: 1, resync: false })).toBe(false);
    expect(device.controls).toHaveLength(2);
    expect(device.syncCount).toBe(1);
  });

  it("fails with ResetError when the device answers with a reset message", async () => {
    const { device, client } = await connect();
    device.resetPaths.add("sys/dev/control");
    await expect(client.setControlValue("pwr", "0")).rejects.toBeInstanceOf(ResetError);
  });
});
