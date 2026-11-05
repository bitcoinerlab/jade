import { base64 } from '@scure/base';
import {
  createJadeClient,
  type ConnectedJadeClient,
  type JadeTransport,
  type JadeTransportListener
} from '@bitcoinerlab/jade';
import type {
  JadeBleDevice,
  JadeBleDiscoveryOptions,
  JadeReactNativeConnectOptions,
  JadeReactNativeDevice,
  NativeSubscription
} from './types.js';

const JADE_BLE_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const JADE_BLE_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const JADE_BLE_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const DEFAULT_TIMEOUT_MS = 30_000;

type BleError = { message?: string };

type BleCharacteristic = { value?: string | null };

type BleDeviceHandle = {
  id: string;
  name?: string | null;
  localName?: string | null;
  rssi?: number | null;
  mtu: number;
  discoverAllServicesAndCharacteristics(): Promise<BleDeviceHandle>;
  requestMTU?(mtu: number): Promise<BleDeviceHandle>;
  monitorCharacteristicForService(
    service: string,
    characteristic: string,
    listener: (
      error: BleError | null,
      characteristic: BleCharacteristic | null
    ) => void
  ): NativeSubscription;
  writeCharacteristicWithResponseForService(
    service: string,
    characteristic: string,
    valueBase64: string
  ): Promise<unknown>;
};

type BleManagerHandle = {
  onStateChange(
    listener: (state: string) => void,
    emitCurrentState: boolean
  ): NativeSubscription;
  startDeviceScan(
    serviceUUIDs: string[] | null,
    options: null,
    listener: (error: BleError | null, device: BleDeviceHandle | null) => void
  ): void | Promise<void>;
  stopDeviceScan(): void | Promise<void>;
  connectToDevice(
    deviceId: string,
    options?: { timeout?: number }
  ): Promise<BleDeviceHandle>;
  onDeviceDisconnected(
    deviceId: string,
    listener: (error: BleError | null) => void
  ): NativeSubscription;
  cancelDeviceConnection(deviceId: string): Promise<unknown>;
  destroy(): Promise<void>;
};

type BlePlxRequire = (specifier: string) => {
  BleManager: {
    new (): BleManagerHandle;
    sharedInstance?: BleManagerHandle | null;
  };
};

type ReactNativeRuntime = {
  Platform: { OS: string; Version: number | string };
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: string;
      BLUETOOTH_SCAN: string;
      BLUETOOTH_CONNECT: string;
    };
    RESULTS: { GRANTED: string };
    requestMultiple(permissions: string[]): Promise<Record<string, string>>;
  };
};

declare const require: BlePlxRequire &
  ((specifier: 'react-native') => ReactNativeRuntime);

function bleManager(): { manager: BleManagerHandle; ownsManager: boolean } {
  try {
    const { BleManager } = require('react-native-ble-plx');
    const shared = BleManager.sharedInstance;
    return { manager: shared ?? new BleManager(), ownsManager: !shared };
  } catch (error) {
    throw new Error('Jade BLE requires react-native-ble-plx', { cause: error });
  }
}

async function ensureBlePermissions(): Promise<void> {
  const { PermissionsAndroid, Platform } = require('react-native');
  if (Platform.OS !== 'android') return;
  const apiLevel = Number(Platform.Version);
  const permissions =
    apiLevel >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const results = await PermissionsAndroid.requestMultiple(permissions);
  const denied = permissions.filter(
    permission => results[permission] !== PermissionsAndroid.RESULTS.GRANTED
  );
  if (denied.length > 0)
    throw new Error(`Jade BLE permissions denied: ${denied.join(', ')}`);
}

function jadeDevice(device: BleDeviceHandle): JadeBleDevice | undefined {
  const name = device.localName ?? device.name ?? undefined;
  if (!name?.toLowerCase().startsWith('jade')) return undefined;
  return {
    transport: 'ble',
    deviceId: device.id,
    name,
    ...(device.rssi !== null && device.rssi !== undefined
      ? { rssi: device.rssi }
      : {})
  };
}

async function waitForBluetooth(
  manager: BleManagerHandle,
  timeoutMs: number
): Promise<void> {
  let subscription: NativeSubscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Timed out waiting for Bluetooth')),
        timeoutMs
      );
      subscription = manager.onStateChange(state => {
        if (state === 'PoweredOn') resolve();
        else if (state === 'PoweredOff')
          reject(new Error('Bluetooth is powered off'));
        else if (state === 'Unauthorized' || state === 'Unsupported')
          reject(new Error(`Bluetooth is ${state.toLowerCase()}`));
      }, true);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    subscription?.remove();
  }
}

export async function discoverJadeBleDevices(
  options: JadeBleDiscoveryOptions = {}
): Promise<JadeBleDevice[]> {
  await ensureBlePermissions();
  const scanDurationMs = options.scanDurationMs ?? 5_000;
  if (!Number.isSafeInteger(scanDurationMs) || scanDurationMs <= 0)
    throw new Error('Jade BLE scan duration must be a positive integer');
  const { manager, ownsManager } = bleManager();
  const devices = new Map<string, JadeBleDevice>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForBluetooth(manager, DEFAULT_TIMEOUT_MS);
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => resolve([...devices.values()]), scanDurationMs);
      void Promise.resolve()
        .then(() =>
          manager.startDeviceScan(null, null, (error, device) => {
            if (error) {
              reject(new Error(error.message ?? 'Jade BLE scan failed'));
              return;
            }
            if (!device) return;
            const discovered = jadeDevice(device);
            if (discovered) devices.set(discovered.deviceId, discovered);
          })
        )
        .catch(reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.resolve()
      .then(() => manager.stopDeviceScan())
      .catch(() => undefined);
    if (ownsManager) await manager.destroy().catch(() => undefined);
  }
}

class ReactNativeBleTransport implements JadeTransport {
  private readonly manager: BleManagerHandle;
  private readonly ownsManager: boolean;
  private readonly device: BleDeviceHandle;
  private readonly writeSize: number;
  private listener: JadeTransportListener | undefined;
  private notifications: NativeSubscription | undefined;
  private disconnection: NativeSubscription | undefined;
  private closed = false;

  constructor(
    manager: BleManagerHandle,
    device: BleDeviceHandle,
    ownsManager: boolean
  ) {
    this.manager = manager;
    this.ownsManager = ownsManager;
    this.device = device;
    this.writeSize = Math.max(20, Math.min(509, device.mtu - 3));
  }

  subscribe(listener: JadeTransportListener): () => void {
    if (this.listener) throw new Error('Jade transport already has a listener');
    this.listener = listener;
    this.notifications = this.device.monitorCharacteristicForService(
      JADE_BLE_SERVICE,
      JADE_BLE_RX,
      (error, characteristic) => {
        if (error) {
          if (!this.closed)
            listener.onError(
              new Error(error.message ?? 'Jade BLE read failed')
            );
          return;
        }
        if (characteristic?.value)
          listener.onData(base64.decode(characteristic.value));
      }
    );
    this.disconnection = this.manager.onDeviceDisconnected(
      this.device.id,
      error => {
        if (this.closed) return;
        if (error)
          listener.onError(new Error(error.message ?? 'Jade BLE disconnected'));
        else listener.onClose();
      }
    );
    return () => this.removeListeners();
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Jade BLE is closed');
    for (let offset = 0; offset < data.length; offset += this.writeSize) {
      await this.device.writeCharacteristicWithResponseForService(
        JADE_BLE_SERVICE,
        JADE_BLE_TX,
        base64.encode(data.subarray(offset, offset + this.writeSize))
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeListeners();
    await this.manager
      .cancelDeviceConnection(this.device.id)
      .catch(() => undefined);
    if (this.ownsManager) await this.manager.destroy().catch(() => undefined);
  }

  private removeListeners(): void {
    this.notifications?.remove();
    this.disconnection?.remove();
    this.notifications = undefined;
    this.disconnection = undefined;
    this.listener = undefined;
  }
}

/** Opens Jade over BLE on iOS or Android. */
export async function connectJadeBle(
  options: JadeReactNativeConnectOptions<JadeReactNativeDevice> = {}
): Promise<ConnectedJadeClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Jade timeout must be a positive integer');
  if (options.device?.transport === 'usb')
    throw new Error('Jade BLE connection requires a BLE device');
  let selected = options.device;
  if (!selected) {
    const devices = await discoverJadeBleDevices({
      scanDurationMs: timeoutMs
    });
    selected = devices[0];
  } else {
    await ensureBlePermissions();
  }
  if (!selected) throw new Error('No Jade BLE device found');

  const { manager, ownsManager } = bleManager();
  let connected = false;
  try {
    await waitForBluetooth(manager, timeoutMs);
    let device = await manager.connectToDevice(selected.deviceId, {
      timeout: timeoutMs
    });
    connected = true;
    if (device.requestMTU) {
      device = await device.requestMTU(517).catch(() => device);
    }
    device = await device.discoverAllServicesAndCharacteristics();
    return createJadeClient(
      new ReactNativeBleTransport(manager, device, ownsManager)
    );
  } catch (error) {
    if (connected)
      await manager
        .cancelDeviceConnection(selected.deviceId)
        .catch(() => undefined);
    if (ownsManager) await manager.destroy().catch(() => undefined);
    throw error;
  }
}
