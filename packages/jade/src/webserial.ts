import { createJadeClient } from './client.js';
import { withTimeout } from './timeout.js';
import type {
  ConnectedJadeClient,
  JadeConnectOptions,
  JadeTransport,
  JadeTransportListener
} from './types.js';

export const JADE_USB_FILTERS = [
  { usbVendorId: 0x10c4, usbProductId: 0xea60 },
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 },
  { usbVendorId: 0x0403, usbProductId: 0x6001 },
  { usbVendorId: 0x1a86, usbProductId: 0x7523 },
  { usbVendorId: 0x303a, usbProductId: 0x4001 },
  { usbVendorId: 0x303a, usbProductId: 0x1001 }
] as const;

export type JadeWebSerialPort = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: {
    baudRate: number;
    dataBits: 8;
    stopBits: 1;
    parity: 'none';
    flowControl: 'none';
  }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
  }): Promise<void>;
};

type WebSerialApi = {
  requestPort(options: {
    filters: readonly {
      usbVendorId: number;
      usbProductId?: number;
    }[];
  }): Promise<JadeWebSerialPort>;
  getPorts(): Promise<JadeWebSerialPort[]>;
};

function webSerialApi(): WebSerialApi {
  const serial = (navigator as Navigator & { serial?: WebSerialApi }).serial;
  if (!serial)
    throw new Error(
      'Web Serial is unavailable; use a supported Chromium-based browser'
    );
  return serial;
}

class WebSerialTransport implements JadeTransport {
  private readonly port: JadeWebSerialPort;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private listener: JadeTransportListener | undefined;
  private readLoop: Promise<void> | undefined;
  private closed = false;

  constructor(port: JadeWebSerialPort) {
    if (!port.readable || !port.writable)
      throw new Error('Jade Web Serial port did not expose readable streams');
    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
  }

  subscribe(listener: JadeTransportListener): () => void {
    if (this.listener) throw new Error('Jade transport already has a listener');
    this.listener = listener;
    this.readLoop = this.read();
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  write(data: Uint8Array): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error('Jade serial port closed'));
    return this.writer.write(data);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader.cancel();
    } catch {}
    try {
      await this.readLoop;
    } catch {}
    try {
      this.reader.releaseLock();
    } catch {}
    try {
      this.writer.releaseLock();
    } catch {}
    await this.port.close();
  }

  private async read(): Promise<void> {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length > 0) this.listener?.onData(value);
      }
      if (!this.closed) this.listener?.onClose();
    } catch (error) {
      if (!this.closed)
        this.listener?.onError(
          error instanceof Error ? error : new Error(String(error))
        );
    }
  }
}

export function getAuthorizedJadeUsbDevices(): Promise<JadeWebSerialPort[]> {
  return webSerialApi().getPorts();
}

/** Opens Jade through the browser Web Serial API. */
export async function connectJadeUsb(
  options: JadeConnectOptions<JadeWebSerialPort> = {}
): Promise<ConnectedJadeClient> {
  const port =
    options.device ??
    (await webSerialApi().requestPort({ filters: JADE_USB_FILTERS }));
  const opening = port.open({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none'
  });
  try {
    await withTimeout(
      opening,
      options.timeoutMs,
      'Timed out opening Jade Web Serial port'
    );
    await port.setSignals?.({
      dataTerminalReady: false,
      requestToSend: false
    });
    return createJadeClient(new WebSerialTransport(port));
  } catch (error) {
    void opening.then(
      () => port.close().catch(() => undefined),
      () => undefined
    );
    await port.close().catch(() => undefined);
    throw error;
  }
}
