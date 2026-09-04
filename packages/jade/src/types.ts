export type JadeNetwork = 'mainnet' | 'testnet' | 'localtest';

export type JadeHttpRequest = {
  urls: readonly (string | { url?: string; onion?: string })[];
  method: string;
  accept?: string;
  data?: unknown;
};

export type JadeHttpRequestFunction = (
  request: JadeHttpRequest
) => Promise<{ body: unknown }>;

export type JadeDescriptorSummary = {
  descriptor_len: number;
  num_datavalues: number;
};

export type JadeRegisteredDescriptor = {
  descriptor_name: string;
  descriptor: string;
  datavalues: Record<string, string>;
};

export type JadeReceiveAddressOptions =
  | {
      variant: 'pkh(k)' | 'sh(wpkh(k))' | 'wpkh(k)' | 'tr(k)';
      path: number[];
    }
  | { descriptorName: string; branch: number; pointer: number };

export type JadeClient = {
  getVersionInfo(): Promise<Record<string, unknown>>;
  authUser(
    network: JadeNetwork,
    httpRequest?: JadeHttpRequestFunction
  ): Promise<boolean>;
  getMasterFingerprint(network: JadeNetwork): Promise<string>;
  getXpub(network: JadeNetwork, path: number[]): Promise<string>;
  getRegisteredDescriptors(): Promise<Record<string, JadeDescriptorSummary>>;
  getRegisteredDescriptor(name: string): Promise<JadeRegisteredDescriptor>;
  registerDescriptor(
    network: JadeNetwork,
    name: string,
    descriptor: string,
    datavalues: Record<string, string>
  ): Promise<boolean>;
  getReceiveAddress(
    network: JadeNetwork,
    options: JadeReceiveAddressOptions
  ): Promise<string>;
  signPSBT(network: JadeNetwork, psbt: Uint8Array): Promise<Uint8Array>;
  signMessage(path: number[], message: string): Promise<string | Uint8Array>;
};

export type ConnectedJadeClient = JadeClient & {
  disconnect(): Promise<void>;
};

export type JadeConnectOptions<TDevice> = {
  device?: TDevice;
  /** Timeout for discovery and opening the transport, not device approval. */
  timeoutMs?: number;
};

export type JadeTransportListener = {
  onData(data: Uint8Array): void;
  onError(error: Error): void;
  onClose(): void;
};

/** Minimal byte-stream transport consumed by the shared Jade RPC client. */
export type JadeTransport = {
  subscribe(listener: JadeTransportListener): () => void;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
};
