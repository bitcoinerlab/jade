import { decode, encode } from 'cbor2';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import {
  connectJadeTcp,
  connectJadeUsb as connectJadeNodeUsb
} from '../src/node.js';
import {
  connectJadeUsb,
  JADE_USB_FILTERS,
  type JadeWebSerialPort
} from '../src/webserial.js';

type Request = { id: string; method: string };

describe('Jade transports', () => {
  it('opens Web Serial and exchanges Jade bytes', async () => {
    let readableController: ReadableStreamDefaultController<Uint8Array>;
    const signals: unknown[] = [];
    let opened = false;
    let closed = false;
    const port: JadeWebSerialPort = {
      readable: new ReadableStream({
        start(controller) {
          readableController = controller;
        }
      }),
      writable: new WritableStream({
        write(data) {
          const request = decode<Request>(data);
          readableController.enqueue(
            encode({ id: request.id, result: { JADE_VERSION: 'web-test' } })
          );
        }
      }),
      async open(options) {
        opened = true;
        assert.equal(options.baudRate, 115200);
      },
      async setSignals(value) {
        signals.push(value);
      },
      async close() {
        closed = true;
      }
    };
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serial: {
          async requestPort({ filters }: { filters: unknown[] }) {
            assert.deepEqual(filters, JADE_USB_FILTERS);
            return port;
          },
          async getPorts() {
            return [port];
          }
        }
      }
    });

    try {
      const client = await connectJadeUsb();
      assert.equal((await client.getVersionInfo())['JADE_VERSION'], 'web-test');
      await client.disconnect();
      assert.equal(opened, true);
      assert.equal(closed, true);
      assert.deepEqual(signals, [
        { dataTerminalReady: false, requestToSend: false }
      ]);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator
      });
    }
  });

  it('connects to Jade QEMU-compatible TCP', async () => {
    const server = createServer(socket => {
      socket.on('data', data => {
        const request = decode<Request>(data);
        socket.write(
          encode({ id: request.id, result: { JADE_VERSION: 'tcp-test' } })
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    try {
      const client = await connectJadeTcp({
        device: { host: '127.0.0.1', port: address.port },
        timeoutMs: 1_000
      });
      assert.equal((await client.getVersionInfo())['JADE_VERSION'], 'tcp-test');
      await client.disconnect();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects a TCP endpoint selected for Node USB', async () => {
    await assert.rejects(
      connectJadeNodeUsb({ device: { host: '127.0.0.1' } }),
      /must include a serial path/
    );
  });
});
