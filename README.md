# BitcoinerLab Jade

Live USB, BLE and development TCP clients for Blockstream Jade.

This repository publishes:

- `@bitcoinerlab/jade`: the shared Jade CBOR-RPC client with browser Web
  Serial and Node serial/TCP providers.
- `@bitcoinerlab/jade-react-native`: BLE and Android USB providers for React
  Native.

Both packages implement the driver contract consumed by
`@bitcoinerlab/descriptors/jade`.

| Runtime          | Provider                          | Connections                         |
| ---------------- | --------------------------------- | ----------------------------------- |
| Chromium browser | `@bitcoinerlab/jade/webserial`    | USB serial                          |
| Node.js          | `@bitcoinerlab/jade/node`         | USB serial, development TCP         |
| React Native     | `@bitcoinerlab/jade-react-native` | iOS/Android BLE, Android USB serial |

The provider opens a byte stream; the shared client handles CBOR framing, device
errors, authentication HTTP continuations, and fragmented PSBT responses.
Descriptors owns policy construction and merges the returned signatures.
QR/air-gapped workflows are not included.

## Development

```sh
npm ci
npm test
npm run format:check
```

Interactive device approvals have no fixed short timeout. Non-interactive RPCs
time out after 120 seconds, close the transport, and reject queued operations.
Always await `session.close()` (or `client.disconnect()` when using the client
directly), including after failures.

The sibling `descriptors-rn-integration` app provides the physical-device test
pipeline. Its `npm run prepare:local` command builds and installs the unpublished
packages. After its Expo Android prebuild, native USB callback tests run with:

```sh
./gradlew :bitcoinerlab-jade-react-native:testDebugUnitTest
```

Run that command from the app's generated `android/` directory. JavaScript mocks,
native builds, and emulator tests do not establish physical BLE/USB validation.
