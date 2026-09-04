import { createConnection, type Socket } from 'node:net';
import type { SerialPort as SerialPortType } from 'serialport';
import { createJadeClient } from './client.js';
import { withTimeout } from './timeout.js';
import { JADE_USB_FILTERS } from './webserial.js';
import type {
  ConnectedJadeClient,
  JadeConnectOptions,
  JadeTransport,
  JadeTransportListener
} from './types.js';

export type JadeNodeUsbDevice = {
  path: string;
  manufacturer?: string | undefined;
  serialNumber?: string | undefined;
  vendorId?: string | undefined;
  productId?: string | undefined;
};

export type JadeTcpDevice = { host?: string; port?: number } | { path: string };

export type JadeNodeDevice = string | JadeNodeUsbDevice | JadeTcpDevice;

type ByteDuplex = {
  on(event: 'data', listener: (data: Uint8Array) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  off(event: 'data', listener: (data: Uint8Array) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  off(event: 'close', listener: () => void): void;
  write(data: Uint8Array, callback: (error?: Error | null) => void): boolean;
};

class NodeTransport implements JadeTransport {
  private readonly stream: ByteDuplex;
  private readonly closeStream: () => Promise<void>;
  private listener: JadeTransportListener | undefined;
  private closed = false;

  private readonly onData = (data: Uint8Array) => {
    this.listener?.onData(new Uint8Array(data));
  };
  private readonly onError = (error: Error) => {
    if (!this.closed) this.listener?.onError(error);
  };
  private readonly onClose = () => {
    if (!this.closed) this.listener?.onClose();
  };

  constructor(stream: ByteDuplex, closeStream: () => Promise<void>) {
    this.stream = stream;
    this.closeStream = closeStream;
  }

  subscribe(listener: JadeTransportListener): () => void {
    if (this.listener) throw new Error('Jade transport already has a listener');
    this.listener = listener;
    this.stream.on('data', this.onData);
    this.stream.on('error', this.onError);
    this.stream.on('close', this.onClose);
    return () => this.removeListeners();
  }

  write(data: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Jade transport closed'));
    return new Promise((resolve, reject) => {
      this.stream.write(data, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeListeners();
    await this.closeStream();
  }

  private removeListeners(): void {
    this.stream.off('data', this.onData);
    this.stream.off('error', this.onError);
    this.stream.off('close', this.onClose);
    this.listener = undefined;
  }
}

function isJadePort(port: JadeNodeUsbDevice): boolean {
  if (!port.vendorId || !port.productId) return false;
  const vendorId = Number.parseInt(port.vendorId, 16);
  const productId = Number.parseInt(port.productId, 16);
  return JADE_USB_FILTERS.some(
    filter =>
      filter.usbVendorId === vendorId && filter.usbProductId === productId
  );
}

async function serialPortModule(): Promise<typeof import('serialport')> {
  try {
    return await import('serialport');
  } catch (error) {
    throw new Error(
      'Node serial support requires the optional serialport package',
      { cause: error }
    );
  }
}

export async function listJadeUsbDevices(): Promise<JadeNodeUsbDevice[]> {
  const { SerialPort } = await serialPortModule();
  return (await SerialPort.list()).filter(isJadePort);
}

function openSerial(port: SerialPortType): Promise<void> {
  return new Promise((resolve, reject) => {
    port.open(error => (error ? reject(error) : resolve()));
  });
}

function setSerialSignals(port: SerialPortType): Promise<void> {
  return new Promise((resolve, reject) => {
    port.set({ dtr: false, rts: false }, error =>
      error ? reject(error) : resolve()
    );
  });
}

function closeSerial(port: SerialPortType): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!port.isOpen) {
      resolve();
      return;
    }
    port.close(error => (error ? reject(error) : resolve()));
  });
}

/** Opens Jade through a desktop Node serial port. */
export async function connectJadeUsb(
  options: JadeConnectOptions<JadeNodeDevice> = {}
): Promise<ConnectedJadeClient> {
  const { SerialPort } = await serialPortModule();
  const selected =
    options.device ??
    (await listJadeUsbDevices())[0] ??
    (() => {
      throw new Error('No Jade USB serial device found');
    })();
  if (typeof selected !== 'string' && !('path' in selected))
    throw new Error('Jade USB device must include a serial path');
  const path = typeof selected === 'string' ? selected : selected.path;
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
  const opening = openSerial(port);
  try {
    await withTimeout(
      opening,
      options.timeoutMs,
      'Timed out opening Jade serial port'
    );
    await setSerialSignals(port);
    return createJadeClient(
      new NodeTransport(port as unknown as ByteDuplex, () => closeSerial(port))
    );
  } catch (error) {
    void opening.then(
      () => closeSerial(port).catch(() => undefined),
      () => undefined
    );
    await closeSerial(port).catch(() => undefined);
    throw error;
  }
}

function connectSocket(
  device: JadeTcpDevice,
  timeoutMs: number | undefined
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      'path' in device
        ? createConnection({ path: device.path })
        : createConnection({
            host: device.host ?? '127.0.0.1',
            port: device.port ?? 30121
          });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
    if (timeoutMs !== undefined) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        cleanup();
        socket.destroy();
        reject(new Error('Jade timeout must be a positive integer'));
        return;
      }
      timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error('Timed out connecting to Jade TCP endpoint'));
      }, timeoutMs);
    }
  });
}

/** Opens Jade's QEMU/libjade development TCP connection. */
export async function connectJadeTcp(
  options: JadeConnectOptions<JadeNodeDevice> = {}
): Promise<ConnectedJadeClient> {
  const selected = options.device;
  const device: JadeTcpDevice =
    typeof selected === 'string'
      ? { path: selected }
      : selected === undefined
        ? {}
        : 'path' in selected
          ? { path: selected.path }
          : selected;
  const socket = await connectSocket(device, options.timeoutMs);
  socket.setNoDelay(true);
  return createJadeClient(
    new NodeTransport(socket as unknown as ByteDuplex, async () => {
      socket.destroy();
    })
  );
}
