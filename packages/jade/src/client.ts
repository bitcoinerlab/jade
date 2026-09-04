import { sha256 } from '@noble/hashes/sha2.js';
import { base58check } from '@scure/base';
import { defaultJadeHttpRequest } from './http.js';
import { JadeRpc } from './rpc.js';
import type {
  ConnectedJadeClient,
  JadeDescriptorSummary,
  JadeHttpRequestFunction,
  JadeNetwork,
  JadeReceiveAddressOptions,
  JadeRegisteredDescriptor,
  JadeTransport
} from './types.js';

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}

function stringResult(value: unknown, method: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Jade ${method} returned an invalid string`);
  return value;
}

/** High-level Bitcoin API implemented over Jade's CBOR-RPC protocol. */
export class JadeClient implements ConnectedJadeClient {
  private readonly rpc: JadeRpc;

  constructor(transport: JadeTransport) {
    this.rpc = new JadeRpc(transport);
  }

  getVersionInfo(): Promise<Record<string, unknown>> {
    return this.rpc
      .call<unknown>('get_version_info')
      .then(value =>
        record(value, 'Jade returned invalid version information')
      );
  }

  authUser(
    network: JadeNetwork,
    httpRequest: JadeHttpRequestFunction = defaultJadeHttpRequest
  ): Promise<boolean> {
    return this.rpc.operation(async request => {
      let response = await request('auth_user', {
        network,
        epoch: Math.floor(Date.now() / 1000)
      });
      for (let continuations = 0; continuations < 16; continuations++) {
        const result = response.result;
        if (!result || typeof result !== 'object' || Array.isArray(result))
          return result === true;
        const httpRequestValue = (result as Record<string, unknown>)[
          'http_request'
        ];
        if (!httpRequestValue || typeof httpRequestValue !== 'object')
          return false;
        const continuation = httpRequestValue as Record<string, unknown>;
        const method = continuation['on-reply'];
        const params = continuation['params'];
        if (typeof method !== 'string' || !params || typeof params !== 'object')
          throw new Error('Jade returned an invalid HTTP continuation');
        const httpResponse = await httpRequest(
          params as Parameters<JadeHttpRequestFunction>[0]
        );
        if (
          !httpResponse ||
          !Object.prototype.hasOwnProperty.call(httpResponse, 'body')
        )
          throw new Error('Jade HTTP callback must return a body');
        response = await request(method, httpResponse.body);
      }
      throw new Error('Jade HTTP continuation limit exceeded');
    }, null);
  }

  async getMasterFingerprint(network: JadeNetwork): Promise<string> {
    const childXpub = await this.getXpub(network, [0]);
    const decoded = base58check(sha256).decode(childXpub);
    if (decoded.length !== 78)
      throw new Error('Jade returned an invalid extended public key');
    return Array.from(decoded.slice(5, 9), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  getXpub(network: JadeNetwork, path: number[]): Promise<string> {
    return this.rpc
      .call<unknown>('get_xpub', { network, path })
      .then(value => stringResult(value, 'get_xpub'));
  }

  async getRegisteredDescriptors(): Promise<
    Record<string, JadeDescriptorSummary>
  > {
    return record(
      await this.rpc.call('get_registered_descriptors'),
      'Jade returned invalid descriptor summaries'
    ) as Record<string, JadeDescriptorSummary>;
  }

  async getRegisteredDescriptor(
    name: string
  ): Promise<JadeRegisteredDescriptor> {
    return record(
      await this.rpc.call('get_registered_descriptor', {
        descriptor_name: name
      }),
      'Jade returned an invalid registered descriptor'
    ) as JadeRegisteredDescriptor;
  }

  registerDescriptor(
    network: JadeNetwork,
    name: string,
    descriptor: string,
    datavalues: Record<string, string>
  ): Promise<boolean> {
    return this.interactiveCall('register_descriptor', {
      network,
      descriptor_name: name,
      descriptor,
      datavalues
    });
  }

  getReceiveAddress(
    network: JadeNetwork,
    options: JadeReceiveAddressOptions
  ): Promise<string> {
    const params =
      'variant' in options
        ? { network, variant: options.variant, path: options.path }
        : {
            network,
            descriptor_name: options.descriptorName,
            branch: options.branch,
            pointer: options.pointer
          };
    return this.interactiveCall<unknown>('get_receive_address', params).then(
      value => stringResult(value, 'get_receive_address')
    );
  }

  signPSBT(network: JadeNetwork, psbt: Uint8Array): Promise<Uint8Array> {
    return this.rpc.operation(async request => {
      let response = await request('sign_psbt', { network, psbt });
      const originalId = response.id;
      const chunks: Uint8Array[] = [];
      let expectedSequence = 1;
      let sequenceLength: number | undefined;
      while (true) {
        if (!(response.result instanceof Uint8Array))
          throw new Error('Jade sign_psbt returned invalid bytes');
        const hasSequence =
          response.seqnum !== undefined || response.seqlen !== undefined;
        if (
          hasSequence &&
          (!Number.isSafeInteger(response.seqnum) ||
            !Number.isSafeInteger(response.seqlen) ||
            response.seqnum !== expectedSequence ||
            response.seqlen! < response.seqnum!)
        )
          throw new Error('Jade sign_psbt returned invalid fragment metadata');
        if (hasSequence) {
          sequenceLength ??= response.seqlen;
          if (response.seqlen !== sequenceLength)
            throw new Error('Jade sign_psbt changed its fragment count');
        } else if (chunks.length > 0) {
          throw new Error('Jade sign_psbt omitted fragment metadata');
        }
        chunks.push(response.result);
        if (
          response.seqnum === undefined ||
          response.seqlen === undefined ||
          response.seqnum === response.seqlen
        )
          break;
        response = await request('get_extended_data', {
          origid: originalId,
          orig: 'sign_psbt',
          seqnum: response.seqnum + 1,
          seqlen: response.seqlen
        });
        expectedSequence += 1;
      }
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const signed = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        signed.set(chunk, offset);
        offset += chunk.length;
      }
      return signed;
    }, null);
  }

  signMessage(path: number[], message: string): Promise<string | Uint8Array> {
    return this.interactiveCall('sign_message', { path, message });
  }

  disconnect(): Promise<void> {
    return this.rpc.disconnect();
  }

  private interactiveCall<T>(method: string, params?: unknown): Promise<T> {
    return this.rpc.call(method, params, null);
  }
}

export function createJadeClient(
  transport: JadeTransport
): ConnectedJadeClient {
  return new JadeClient(transport);
}
