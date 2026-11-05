import './textEncoding.js';
import { decodeSequence, encode, getEncoded, unbox } from 'cbor2';
import { JadeRpcError } from './errors.js';
import type { JadeTransport } from './types.js';

type JadeRpcResponse = {
  id: string;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
  seqnum?: number;
  seqlen?: number;
};

type JadeRequest = (
  method: string,
  params?: unknown
) => Promise<JadeRpcResponse>;

const DEFAULT_RPC_TIMEOUT_MS = 120_000;

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isIncompleteCbor(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (error instanceof Error &&
      error.message.startsWith('Unexpected end of stream'))
  );
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(left.length + right.length);
  value.set(left);
  value.set(right, left.length);
  return value;
}

export class JadeRpc {
  private readonly transport: JadeTransport;
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<
    string,
    {
      resolve(response: JadeRpcResponse): void;
      reject(error: Error): void;
    }
  >();

  private buffer = new Uint8Array();
  private nextRequestId = 1;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(transport: JadeTransport) {
    this.transport = transport;
    this.unsubscribe = transport.subscribe({
      onData: data => this.receive(data),
      onError: error => this.fail(error),
      onClose: () => this.fail(new Error('Jade transport closed'))
    });
  }

  operation<T>(
    run: (request: JadeRequest) => Promise<T>,
    timeoutMs: number | null = DEFAULT_RPC_TIMEOUT_MS
  ): Promise<T> {
    const operation = this.operationTail.then(() =>
      run((method, params) => this.request(method, params, timeoutMs))
    );
    this.operationTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  call<T>(
    method: string,
    params?: unknown,
    timeoutMs: number | null = DEFAULT_RPC_TIMEOUT_MS
  ): Promise<T> {
    return this.operation(async request => {
      const response = await request(method, params);
      return response.result as T;
    }, timeoutMs);
  }

  disconnect(): Promise<void> {
    return this.close(new Error('Jade transport closed'));
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number | null
  ): Promise<JadeRpcResponse> {
    if (this.closed) throw new Error('Jade transport is closed');
    if (!method || method.length > 32)
      throw new Error('Jade RPC method must contain 1 to 32 characters');

    const id = `j${this.nextRequestId.toString(36)}`;
    this.nextRequestId += 1;
    if (id.length > 16) throw new Error('Jade RPC request ID overflow');
    if (
      timeoutMs !== null &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    )
      throw new Error('Jade RPC timeout must be a positive integer');
    const message = encode({
      id,
      method,
      ...(params !== undefined ? { params } : {})
    });
    let written = false;
    let reply: JadeRpcResponse | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<JadeRpcResponse>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => {
          reply = value;
          if (written) resolve(value);
        },
        reject
      });
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this.fail(new Error(`Jade RPC ${method} timed out`));
        }, timeoutMs);
      }

      // A reply can arrive before the write finishes. Keep the request pending
      // until both complete so timeout and disconnect still cancel a stuck write.
      void Promise.resolve()
        .then(() => this.transport.write(message))
        .then(
          () => {
            written = true;
            if (reply) resolve(reply);
          },
          error => this.fail(errorValue(error))
        );
    });

    try {
      return await response;
    } catch (error) {
      // Do not let the next operation interleave with an unfinished write.
      if (!written) this.fail(errorValue(error));
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private receive(data: Uint8Array): void {
    if (this.closed || data.length === 0) return;
    this.buffer = append(this.buffer, data);
    let consumed = 0;
    try {
      for (const boxedResponse of decodeSequence(this.buffer, {
        saveOriginal: true
      })) {
        const encoded = getEncoded(boxedResponse);
        if (!encoded)
          throw new Error('Jade CBOR decoder did not preserve message length');
        consumed += encoded.length;
        this.dispatch(unbox(boxedResponse));
      }
      this.buffer = new Uint8Array();
    } catch (error) {
      if (consumed > 0) this.buffer = this.buffer.slice(consumed);
      if (!isIncompleteCbor(error)) this.fail(errorValue(error));
    }
  }

  private dispatch(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.fail(new Error('Jade returned an invalid RPC response'));
      return;
    }
    const response = value as JadeRpcResponse;
    if (typeof response.id !== 'string') {
      if ('log' in response) return;
      this.fail(new Error('Jade returned an RPC response without an ID'));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;

    if (response.error !== undefined) {
      if (!response.error || typeof response.error !== 'object') {
        pending.reject(new Error('Jade returned an invalid RPC error'));
        return;
      }
      const code = response.error.code;
      const message = response.error.message;
      pending.reject(
        new JadeRpcError({
          code: typeof code === 'number' ? code : -32603,
          message:
            typeof message === 'string' ? message : 'Unknown Jade RPC error',
          ...(response.error.data !== undefined
            ? { data: response.error.data }
            : {})
        })
      );
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
      pending.reject(new Error('Jade RPC response has no result'));
      return;
    }
    pending.resolve(response);
  }

  private fail(error: Error): void {
    void this.close(error).catch(() => undefined);
  }

  private close(error: Error): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.unsubscribe();
      this.rejectPending(error);
      this.closing = Promise.resolve().then(() => this.transport.close());
    }
    return this.closing;
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }
}
