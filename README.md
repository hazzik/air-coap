# air-coap

TypeScript library and CLI for controlling Philips air purifiers over the local network using the encrypted CoAP protocol. It is a port of the Python package [aioairctrl](https://pypi.org/project/aioairctrl/) 0.3.1.

## Overview

Philips air purifiers (AC series) expose a CoAP endpoint on port 5683 of your local network. This library talks to that endpoint with the AES-128/CBC encryption scheme of the Philips app. No cloud connection or account is required.

Supported operations:

- Read the current device status: all sensor readings and settings
- Observe live status updates as the device pushes them
- Send control commands to change settings

The client sends the same CoAP messages and the same command bytes as aioairctrl 0.3.1.

## Requirements

- Node.js 22, 24 or 26
- The air purifier must be on the same local network, or reachable by IP

## Installation

```bash
yarn install
yarn build
npm install --global .
```

The last command installs the `air-coap` command. Without it, run `node dist/bin.js` in place of `air-coap`.

Also installs alias command under the name `aioairctrl`, which takes the same arguments as the command of the Python package.

## Command-line usage

All commands require the `-H`/`--host` flag with the IP address of your purifier. Find it in your router's DHCP table or the Philips app.

### Get current status

```bash
air-coap -H 192.168.1.100 status
```

Add `--json` to get machine-readable output:

```bash
air-coap -H 192.168.1.100 status --json
```

### Watch for live updates

Stays connected and prints a new line each time the device reports a change, for example a sensor reading or a mode change:

```bash
air-coap -H 192.168.1.100 status-observe
air-coap -H 192.168.1.100 status-observe --json
```

Press `Ctrl+C` to stop.

### Set a value

String values:

```bash
air-coap -H 192.168.1.100 set mode=AG
```

Boolean values (`true`/`false` are handled automatically):

```bash
air-coap -H 192.168.1.100 set pwr=true
air-coap -H 192.168.1.100 set pwr=false
```

Integer values (use `-I`/`--int`):

```bash
air-coap -H 192.168.1.100 set -I om=2
```

Multiple values at once:

```bash
air-coap -H 192.168.1.100 set -I pwr=true om=2
```

### Debug output

Add `-D`/`--debug` to any command to see each CoAP message and the decrypted payloads on stderr:

```bash
air-coap -H 192.168.1.100 --debug status
```

## TypeScript API

```typescript
import { CoAPClient } from "air-coap";

const client = await CoAPClient.create({ host: "192.168.1.100" });
try {
  // Read status once
  const { status, maxAge } = await client.getStatus();
  console.log(status, maxAge);

  // Stream live updates
  for await (const update of client.observeStatus()) {
    console.log(update);
    break; // stop after first update
  }

  // Send a command
  await client.setControlValue("pwr", true);

  // Send multiple values at once
  await client.setControlValues({ om: 2, rhset: 50 });
} finally {
  await client.shutdown();
}
```

`CoAPClient.create` takes these options:

- `host`: address of the device
- `port`: CoAP port, 5683 by default
- `logger`: an object with `debug(message)` and `error(message)`. By default the client drops debug messages and writes errors to `console.error`.
- `signal`: an `AbortSignal` that cancels the initial key exchange

`setControlValues(data, options)` and `setControlValue(key, value, options)` return `true` when the device accepts the command. They take these options:

- `retryCount`: number of retries after the first attempt, 5 by default
- `resync`: exchange the client key again after the first failed attempt, `true` by default
- `signal`: an `AbortSignal`

`getStatus` and `observeStatus` also take a `signal`.

Requests have no timeout, because the device may not answer a lost message. To stop waiting, abort the `signal` or call `shutdown()`:

- Aborting a `signal` rejects the call with the signal's reason.
- `shutdown()` rejects every pending call and observation with `ShutdownError`.

These errors come from the device:

- `ResetError`: the device rejected a request with a CoAP reset message.
- `NotObservableError`: `observeStatus` received a response without the Observe option, so the observation has ended.
- `DigestMismatchError`: the digest of an encrypted payload does not match its content.

## Development

```bash
yarn test
yarn lint
yarn types
yarn format:check
```

## License

MIT
