import { base64 } from '@scure/base';
import { decode, encode } from 'cbor2';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectJadeBle, connectJadeUsb } from '../src/index.js';

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
        const request = decode<Request>(base64.decode(data));
        notification?.(null, {
          value: base64.encode(
            encode({ id: request.id, result: { JADE_VERSION: 'ble-test' } })
          )
        });
      }
    };
    class FakeBleManager {
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
      await client.disconnect();
      assert.equal(cancelled, 'ble-device');
      assert.equal(destroyed, true);
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
