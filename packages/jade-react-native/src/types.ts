export type JadeReactNativeConnectOptions<TDevice> = {
  device?: TDevice;
  timeoutMs?: number;
};

export type JadeBleDiscoveryOptions = {
  scanDurationMs?: number;
};

export type JadeBleDevice = {
  transport: 'ble';
  deviceId: string;
  name?: string;
  rssi?: number;
};

export type JadeUsbDevice = {
  transport: 'usb';
  deviceId: string;
  name?: string;
  vendorId: number;
  productId: number;
};

export type JadeReactNativeDevice = JadeBleDevice | JadeUsbDevice;

export type NativeSubscription = { remove(): void };

export type JadeNativeModule = {
  listUsb(): Promise<JadeUsbDevice[]>;
  connectUsb(paramsJSON: string): Promise<{ id: string }>;
  writeUsb(sessionId: string, data: string): Promise<void>;
  disconnectUsb(sessionId: string): Promise<void>;
  addListener(
    event: 'onUsbData' | 'onUsbError' | 'onUsbClose',
    listener: (event: {
      sessionId: string;
      data?: string;
      message?: string;
    }) => void
  ): NativeSubscription;
};
