import { base64 } from '@scure/base';
import { decode, encode } from 'cbor2';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  connectJadeBle,
  connectJadeUsb,
  discoverJadeBleDevices
} from '../src/index.js';

type Request = { id: string; method: string };
type Event = {
  sessionId: string;
  data?: string;
  message?: string;
};

describe('React Native Jade providers', () => {
  it('adapts the Android USB native module to Jade bytes', async () => {
    const listeners = new Map<string, (event: Event) => void>();
    let connectParams = '';
    let disconnected = '';
    const nativeModule = {
      async listUsb() {
        return [];
      },
      async connectUsb(params: string) {
        connectParams = params;
        return { id: 'usb-session' };
      },
      async writeUsb(sessionId: string, data: string) {
        assert.equal(sessionId, 'usb-session');
        const request = decode<Request>(base64.decode(data));
        listeners.get('onUsbData')?.({
          sessionId,
          data: base64.encode(
            encode({ id: request.id, result: { JADE_VERSION: 'usb-test' } })
          )
        });
      },
      async disconnectUsb(sessionId: string) {
        disconnected = sessionId;
      },
      addListener(event: string, listener: (value: Event) => void) {
        listeners.set(event, listener);
        return { remove: () => listeners.delete(event) };
      }
    };
    const previousRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', (specifier: string) => {
      assert.equal(specifier, 'expo-modules-core');
      return { requireNativeModule: () => nativeModule };
    });

    try {
      const client = await connectJadeUsb({
        device: {
          transport: 'usb',
          deviceId: 'device-1',
          vendorId: 0x303a,
          productId: 0x4001
        },
        timeoutMs: 1_000
      });
      assert.deepEqual(JSON.parse(connectParams), {
        deviceId: 'device-1',
        timeoutMs: 1_000
      });
      assert.equal((await client.getVersionInfo())['JADE_VERSION'], 'usb-test');
      await client.disconnect();
      assert.equal(disconnected, 'usb-session');
    } finally {
      Reflect.set(globalThis, 'require', previousRequire);
    }
  });

  it('adapts BLE notifications and writes to Jade bytes', async () => {
    let notification:
      | ((
          error: { message?: string } | null,
          characteristic: { value?: string | null } | null
        ) => void)
      | undefined;
    let cancelled = '';
    let destroyed = false;
    const writes: number[] = [];
    let received = Buffer.alloc(0);
    const subscription = { remove() {} };
    const device = {
      id: 'ble-device',
      name: 'Jade',
      mtu: 100,
      async requestMTU() {
        return this;
      },
      async discoverAllServicesAndCharacteristics() {
        return this;
      },
      monitorCharacteristicForService(
        _service: string,
        _characteristic: string,
        listener: typeof notification
      ) {
        notification = listener;
        return subscription;
      },
      async writeCharacteristicWithResponseForService(
        _service: string,
        _characteristic: string,
        data: string
      ) {
        const chunk = base64.decode(data);
        writes.push(chunk.length);
        received = Buffer.concat([received, chunk]);
        let request: Request;
        try {
          request = decode<Request>(received);
        } catch (error) {
          if (
            error instanceof RangeError ||
            (error instanceof Error &&
              error.message.startsWith('Unexpected end of stream'))
          )
            return;
          throw error;
        }
        received = Buffer.alloc(0);
        notification?.(null, {
          value: base64.encode(
            encode({
              id: request.id,
              result:
                request.method === 'sign_message'
                  ? 'signature'
                  : { JADE_VERSION: 'ble-test' }
            })
          )
        });
      }
    };
    class FakeBleManager {
      onStateChange(listener: (state: string) => void) {
        listener('PoweredOn');
        return subscription;
      }
      async connectToDevice() {
        return device;
      }
      onDeviceDisconnected() {
        return subscription;
      }
      async cancelDeviceConnection(deviceId: string) {
        cancelled = deviceId;
      }
      async destroy() {
        destroyed = true;
      }
    }
    const previousRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', (specifier: string) => {
      if (specifier === 'react-native-ble-plx')
        return { BleManager: FakeBleManager };
      assert.equal(specifier, 'react-native');
      return {
        Platform: { OS: 'ios', Version: 18 },
        PermissionsAndroid: {}
      };
    });

    try {
      const client = await connectJadeBle({
        device: { transport: 'ble', deviceId: 'ble-device', name: 'Jade' }
      });
      assert.equal((await client.getVersionInfo())['JADE_VERSION'], 'ble-test');
      assert.equal(
        await client.signMessage([0x80000054, 0, 0], 'chunked '.repeat(60)),
        'signature'
      );
      assert.ok(writes.length > 5);
      assert.ok(writes.every(length => length <= 97));
      await client.disconnect();
      assert.equal(cancelled, 'ble-device');
      assert.equal(destroyed, true);
    } finally {
      Reflect.set(globalThis, 'require', previousRequire);
    }
  });

  it('waits for Bluetooth and deduplicates discovered Jade devices', async () => {
    let poweredOn = false;
    let removed = false;
    const cleanup: string[] = [];
    class FakeBleManager {
      onStateChange(listener: (state: string) => void) {
        listener('Unknown');
        setImmediate(() => {
          poweredOn = true;
          listener('PoweredOn');
        });
        return {
          remove() {
            removed = true;
          }
        };
      }
      async startDeviceScan(
        _services: null,
        _options: null,
        listener: (error: null, device: object) => void
      ) {
        assert.equal(poweredOn, true);
        listener(null, { id: 'other', name: 'Not Jade' });
        listener(null, { id: 'jade', name: 'Jade', rssi: -80 });
        listener(null, { id: 'jade', localName: 'Jade Plus', rssi: -40 });
      }
      async stopDeviceScan() {
        cleanup.push('stop');
      }
      async destroy() {
        cleanup.push('destroy');
      }
    }
    const previousRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', (specifier: string) => {
      if (specifier === 'react-native-ble-plx')
        return { BleManager: FakeBleManager };
      assert.equal(specifier, 'react-native');
      return { Platform: { OS: 'ios' }, PermissionsAndroid: {} };
    });
    try {
      assert.deepEqual(await discoverJadeBleDevices({ scanDurationMs: 10 }), [
        { transport: 'ble', deviceId: 'jade', name: 'Jade Plus', rssi: -40 }
      ]);
      assert.equal(removed, true);
      assert.deepEqual(cleanup, ['stop', 'destroy']);
    } finally {
      Reflect.set(globalThis, 'require', previousRequire);
    }
  });

  it(
    'handles asynchronous BLE scan failures and releases the manager',
    { timeout: 1_000 },
    async () => {
      let destroyed = false;
      class FakeBleManager {
        onStateChange(listener: (state: string) => void) {
          listener('PoweredOn');
          return { remove() {} };
        }
        async startDeviceScan() {
          throw new Error('native scan failed');
        }
        async stopDeviceScan() {
          throw new Error('native stop failed');
        }
        async destroy() {
          destroyed = true;
        }
      }
      const previousRequire = Reflect.get(globalThis, 'require');
      Reflect.set(globalThis, 'require', (specifier: string) => {
        if (specifier === 'react-native-ble-plx')
          return { BleManager: FakeBleManager };
        assert.equal(specifier, 'react-native');
        return { Platform: { OS: 'ios' }, PermissionsAndroid: {} };
      });
      try {
        await assert.rejects(discoverJadeBleDevices(), /native scan failed/);
        assert.equal(destroyed, true);
      } finally {
        Reflect.set(globalThis, 'require', previousRequire);
      }
    }
  );

  it('rejects a powered-off Bluetooth adapter without scanning', async () => {
    let destroyed = false;
    class FakeBleManager {
      onStateChange(listener: (state: string) => void) {
        listener('PoweredOff');
        return { remove() {} };
      }
      async startDeviceScan() {
        assert.fail('must not scan');
      }
      async stopDeviceScan() {}
      async destroy() {
        destroyed = true;
      }
    }
    const previousRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', (specifier: string) => {
      if (specifier === 'react-native-ble-plx')
        return { BleManager: FakeBleManager };
      assert.equal(specifier, 'react-native');
      return { Platform: { OS: 'ios' }, PermissionsAndroid: {} };
    });
    try {
      await assert.rejects(discoverJadeBleDevices(), /powered off/);
      assert.equal(destroyed, true);
    } finally {
      Reflect.set(globalThis, 'require', previousRequire);
    }
  });

  it('does not destroy a BLE manager already owned by another wallet', async () => {
    const shared = {
      onStateChange(listener: (state: string) => void) {
        listener('PoweredOn');
        return { remove() {} };
      },
      async startDeviceScan() {},
      async stopDeviceScan() {},
      async destroy() {
        assert.fail('must not destroy the shared manager');
      }
    };
    class FakeBleManager {
      static sharedInstance = shared;
      constructor() {
        assert.fail('must reuse the shared manager');
      }
    }
    const previousRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', (specifier: string) => {
      if (specifier === 'react-native-ble-plx')
        return { BleManager: FakeBleManager };
      assert.equal(specifier, 'react-native');
      return { Platform: { OS: 'ios' }, PermissionsAndroid: {} };
    });
    try {
      assert.deepEqual(await discoverJadeBleDevices({ scanDurationMs: 1 }), []);
    } finally {
      Reflect.set(globalThis, 'require', previousRequire);
    }
  });

  it('closes a failed BLE connection without destroying a shared manager', async () => {
    let cancelled = '';
    const shared = {
      onStateChange(listener: (state: string) => void) {
        listener('PoweredOn');
        return { remove() {} };
      },
      async connectToDevice() {
        return {
          id: 'jade',
          async discoverAllServicesAndCharacteristics() {
            throw new Error('service discovery failed');
          }
        };
      },
      async cancelDeviceConnection(deviceId: string) {
        cancelled = deviceId;
      },
      async destroy() {
        assert.fail('must not destroy the shared manager');
      }
    };
    class FakeBleManager {
      static sharedInstance = shared;
    }
    const previousRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', (specifier: string) => {
      if (specifier === 'react-native-ble-plx')
        return { BleManager: FakeBleManager };
      assert.equal(specifier, 'react-native');
      return { Platform: { OS: 'ios' }, PermissionsAndroid: {} };
    });
    try {
      await assert.rejects(
        connectJadeBle({ device: { transport: 'ble', deviceId: 'jade' } }),
        /service discovery failed/
      );
      assert.equal(cancelled, 'jade');
    } finally {
      Reflect.set(globalThis, 'require', previousRequire);
    }
  });

  it('rejects denied Android BLE runtime permissions', async () => {
    const previousRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', (specifier: string) => {
      assert.equal(specifier, 'react-native');
      return {
        Platform: { OS: 'android', Version: 35 },
        PermissionsAndroid: {
          PERMISSIONS: {
            ACCESS_FINE_LOCATION: 'location',
            BLUETOOTH_SCAN: 'scan',
            BLUETOOTH_CONNECT: 'connect'
          },
          RESULTS: { GRANTED: 'granted' },
          async requestMultiple() {
            return { scan: 'denied', connect: 'granted' };
          }
        }
      };
    });

    try {
      await assert.rejects(
        connectJadeBle({
          device: { transport: 'ble', deviceId: 'ble-device' }
        }),
        /permissions denied: scan/
      );
    } finally {
      Reflect.set(globalThis, 'require', previousRequire);
    }
  });

  it('rejects devices selected for the wrong transport', async () => {
    await assert.rejects(
      connectJadeUsb({
        device: { transport: 'ble', deviceId: 'ble-device' }
      }),
      /requires a USB device/
    );
    await assert.rejects(
      connectJadeBle({
        device: {
          transport: 'usb',
          deviceId: 'usb-device',
          vendorId: 0x303a,
          productId: 0x4001
        }
      }),
      /requires a BLE device/
    );
  });
});
