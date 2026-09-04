import { Wtf8Decoder, Wtf8Encoder } from '@cto.af/wtf8';

class PortableTextDecoder extends Wtf8Decoder {
  constructor(_label = 'utf-8', options?: TextDecoderOptions) {
    super('wtf8', options);
  }
}

if (typeof globalThis.TextEncoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextEncoder', {
    configurable: true,
    writable: true,
    value: Wtf8Encoder
  });
}

if (typeof globalThis.TextDecoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextDecoder', {
    configurable: true,
    writable: true,
    value: PortableTextDecoder
  });
}
