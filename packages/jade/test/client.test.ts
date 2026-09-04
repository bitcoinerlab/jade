import { sha256 } from '@noble/hashes/sha2.js';
import { base58check } from '@scure/base';
import { decode, encode } from 'cbor2';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { JadeClient, JadeRpc, JadeRpcError } from '../src/index.js';
import type { JadeTransport, JadeTransportListener } from '../src/index.js';

type Request = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

function concat(...items: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    items.reduce((length, item) => length + item.length, 0)
  );
  let offset = 0;
  for (const item of items) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

class FakeTransport implements JadeTransport {
  readonly requests: Request[] = [];
  onRequest: (request: Request) => void | Promise<void> = () => undefined;
  private listener: JadeTransportListener | undefined;
  closed = false;

  subscribe(listener: JadeTransportListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async write(data: Uint8Array): Promise<void> {
    const request = decode<Request>(data);
    this.requests.push(request);
    await this.onRequest(request);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  respond(response: unknown): void {
    this.listener?.onData(encode(response));
  }

  respondBytes(bytes: Uint8Array): void {
    this.listener?.onData(bytes);
  }
}

describe('JadeClient', () => {
  it('decodes partial and back-to-back CBOR responses', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    transport.onRequest = request => {
      const ignored = encode({ id: 'unknown', result: false });
      const response = encode({
        id: request.id,
        result: { JADE_VERSION: '1.0.0' }
      });
      const messages = concat(ignored, response);
      const split = Math.floor(messages.length / 2);
      transport.respondBytes(messages.slice(0, split));
      transport.respondBytes(messages.slice(split));
    };

    assert.deepEqual(await client.getVersionInfo(), {
      JADE_VERSION: '1.0.0'
    });
    await client.disconnect();
  });

  it('handles HTTP authentication continuations', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    transport.onRequest = request => {
      if (request.method === 'auth_user') {
        transport.respond({
          id: request.id,
          result: {
            http_request: {
              'on-reply': 'pinserver_reply',
              params: {
                urls: ['https://example.com'],
                method: 'POST',
                accept: 'json',
                data: { request: 1 }
              }
            }
          }
        });
      } else {
        assert.equal(request.method, 'pinserver_reply');
        assert.deepEqual(request.params, { response: 2 });
        transport.respond({ id: request.id, result: true });
      }
    };

    const calls: unknown[] = [];
    const authenticated = await client.authUser('mainnet', async request => {
      calls.push(request);
      return { body: { response: 2 } };
    });

    assert.equal(authenticated, true);
    assert.equal(calls.length, 1);
    await client.disconnect();
  });

  it('assembles every one-based sign_psbt fragment', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    let originalId = '';
    transport.onRequest = request => {
      if (request.method === 'sign_psbt') {
        originalId = request.id;
        transport.respond({
          id: request.id,
          result: new Uint8Array([1]),
          seqnum: 1,
          seqlen: 3
        });
        return;
      }
      assert.equal(request.method, 'get_extended_data');
      const seqnum = request.params?.['seqnum'];
      assert.deepEqual(request.params, {
        origid: originalId,
        orig: 'sign_psbt',
        seqnum,
        seqlen: 3
      });
      assert.notEqual(request.id, originalId);
      transport.respond({
        id: request.id,
        result: new Uint8Array([Number(seqnum)]),
        seqnum,
        seqlen: 3
      });
    };

    assert.deepEqual(
      await client.signPSBT('localtest', new Uint8Array([0xff])),
      new Uint8Array([1, 2, 3])
    );
    await client.disconnect();
  });

  it('preserves Jade device error details', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    transport.onRequest = request => {
      transport.respond({
        id: request.id,
        error: { code: -32000, message: 'User cancelled', data: { screen: 2 } }
      });
    };

    await assert.rejects(client.getVersionInfo(), error => {
      assert.ok(error instanceof JadeRpcError);
      assert.equal(error.code, -32000);
      assert.deepEqual(error.data, { screen: 2 });
      return true;
    });
    await client.disconnect();
  });

  it('rejects malformed error replies without hanging', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    transport.onRequest = request => {
      transport.respond({ id: request.id, error: null });
    };

    await assert.rejects(client.getVersionInfo(), /invalid RPC error/);
    await client.disconnect();
  });

  it('ignores Jade log frames while awaiting a response', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    transport.onRequest = request => {
      transport.respondBytes(
        concat(
          encode({ log: new Uint8Array([1, 2]) }),
          encode({ id: request.id, result: { JADE_VERSION: 'after-log' } })
        )
      );
    };

    assert.equal((await client.getVersionInfo())['JADE_VERSION'], 'after-log');
    await client.disconnect();
  });

  it('derives the master fingerprint from a child xpub', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    const payload = new Uint8Array(78);
    payload.set([0x04, 0x35, 0x87, 0xcf]);
    payload[4] = 1;
    payload.set([0xde, 0xad, 0xbe, 0xef], 5);
    const xpub = base58check(sha256).encode(payload);
    transport.onRequest = request => {
      assert.deepEqual(request.params, { network: 'testnet', path: [0] });
      transport.respond({ id: request.id, result: xpub });
    };

    assert.equal(await client.getMasterFingerprint('testnet'), 'deadbeef');
    await client.disconnect();
  });

  it('rejects a pending operation when disconnected', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    const version = client.getVersionInfo();
    await new Promise(resolve => setTimeout(resolve, 0));
    await client.disconnect();

    await assert.rejects(version, /transport closed/);
    assert.equal(transport.closed, true);
  });

  it('serializes complete interactive operations', async () => {
    const transport = new FakeTransport();
    const client = new JadeClient(transport);
    const replies: (() => void)[] = [];
    transport.onRequest = request => {
      replies.push(() =>
        transport.respond({
          id: request.id,
          result: { method: request.method }
        })
      );
    };

    const first = client.getVersionInfo();
    const second = client.getVersionInfo();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(transport.requests.length, 1);
    replies.shift()?.();
    await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(transport.requests.length, 2);
    replies.shift()?.();
    await second;
    await client.disconnect();
  });

  it('closes the transport after an RPC timeout', async () => {
    const transport = new FakeTransport();
    const rpc = new JadeRpc(transport);

    await assert.rejects(rpc.call('ping', undefined, 5), /ping timed out/);
    assert.equal(transport.closed, true);
  });

  it('loads without native TextEncoder or TextDecoder globals', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `delete globalThis.TextEncoder;
delete globalThis.TextDecoder;
await import('./dist/index.js');
if (typeof TextEncoder !== 'function' || typeof TextDecoder !== 'function') process.exit(1);
const bytes = new TextEncoder().encode('Jade');
if (new TextDecoder().decode(bytes) !== 'Jade') process.exit(2);`
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
  });
});
