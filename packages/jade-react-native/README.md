# @bitcoinerlab/jade-react-native

React Native BLE and Android USB provider for Blockstream Jade.

```ts
import { networks } from '@bitcoinerlab/descriptors';
import * as jade from '@bitcoinerlab/descriptors/jade';

const session = await jade.connect({
  driver: {
    module: import('@bitcoinerlab/jade-react-native'),
    mode: 'ble',
    timeoutMs: 60_000
  },
  network: networks.bitcoin,
  store: {}
});
```

Use `mode: 'usb'` for Android USB serial. iOS USB is not supported.

`discoverJadeBleDevices({ scanDurationMs: 5000 })` lists nearby Jade devices.
`listAttachedJadeUsbDevices()` lists attached Android USB devices. Pass a result
as `driver.device`, or omit it for the first matching device. Discovery does not
authenticate the wallet; `connect()` does, and PIN authentication needs network
access unless Jade is already unlocked.

BLE operations wait for the adapter to become ready and release their scans,
subscriptions, and connections. An existing `react-native-ble-plx` shared manager
is reused without destroying it, so switching between Jade and Ledger does not
invalidate Ledger's cached manager. Do not run wallet connections concurrently.

This package requires a custom development/native build and does not run in
Expo Go. Add `@bitcoinerlab/jade-react-native/app.plugin` to the Expo app
configuration.

When another wallet plugin already configures Android's USB auto-launch filter,
this plugin preserves it. Jade USB discovery and connection still work from
inside the app; automatic launch on Jade attachment is not configured in that
case.

Install the native peers in the application:

```bash
npx expo install expo-modules-core react-native-ble-plx
```
