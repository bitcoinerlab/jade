export class JadeRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor({
    code,
    message,
    data
  }: {
    code: number;
    message: string;
    data?: unknown;
  }) {
    super(message);
    this.name = 'JadeRpcError';
    this.code = code;
    this.data = data;
  }
}
