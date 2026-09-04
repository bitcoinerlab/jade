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

This package requires a custom development/native build and does not run in
Expo Go. Add `@bitcoinerlab/jade-react-native/app.plugin` to the Expo app
configuration.

Install the native peers in the application:

```bash
npx expo install expo-modules-core react-native-ble-plx
```
