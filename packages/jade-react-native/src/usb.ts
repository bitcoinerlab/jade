import { base64 } from '@scure/base';
import {
  createJadeClient,
  type ConnectedJadeClient,
  type JadeTransport,
  type JadeTransportListener
} from '@bitcoinerlab/jade';
import { getJadeNativeModule } from './nativeModule.js';
import type {
  JadeReactNativeConnectOptions,
  JadeReactNativeDevice,
  JadeUsbDevice
} from './types.js';

class ReactNativeUsbTransport implements JadeTransport {
  private readonly sessionId: string;
  private listener: JadeTransportListener | undefined;
  private subscriptions: { remove(): void }[] = [];
  private closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  subscribe(listener: JadeTransportListener): () => void {
    if (this.listener) throw new Error('Jade transport already has a listener');
    this.listener = listener;
    const module = getJadeNativeModule();
    this.subscriptions = [
      module.addListener('onUsbData', event => {
        if (event.sessionId === this.sessionId && event.data)
          listener.onData(base64.decode(event.data));
      }),
      module.addListener('onUsbError', event => {
        if (event.sessionId === this.sessionId)
          listener.onError(new Error(event.message ?? 'Jade USB error'));
      }),
      module.addListener('onUsbClose', event => {
        if (event.sessionId === this.sessionId) listener.onClose();
      })
    ];
    return () => this.removeListeners();
  }

  write(data: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Jade USB is closed'));
    return getJadeNativeModule().writeUsb(this.sessionId, base64.encode(data));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeListeners();
    await getJadeNativeModule().disconnectUsb(this.sessionId);
  }

  private removeListeners(): void {
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
    this.listener = undefined;
  }
}

export function listAttachedJadeUsbDevices(): Promise<JadeUsbDevice[]> {
  return getJadeNativeModule().listUsb();
}

/** Opens an attached Jade over Android USB serial. */
export async function connectJadeUsb(
  options: JadeReactNativeConnectOptions<JadeReactNativeDevice> = {}
): Promise<ConnectedJadeClient> {
  if (options.device?.transport === 'ble')
    throw new Error('Jade USB connection requires a USB device');
  const session = await getJadeNativeModule().connectUsb(
    JSON.stringify({
      ...(options.device !== undefined
        ? { deviceId: options.device.deviceId }
        : {}),
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {})
    })
  );
  return createJadeClient(new ReactNativeUsbTransport(session.id));
}
