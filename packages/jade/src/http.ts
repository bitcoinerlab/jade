import type { JadeHttpRequest, JadeHttpRequestFunction } from './types.js';

function clearWebUrls(request: JadeHttpRequest): string[] {
  return request.urls.flatMap(candidate => {
    const url = typeof candidate === 'string' ? candidate : candidate.url;
    return url && !url.toLowerCase().includes('.onion') ? [url] : [];
  });
}

/** Default blind-pinserver proxy used when the application does not inject one. */
export const defaultJadeHttpRequest: JadeHttpRequestFunction =
  async request => {
    const urls = clearWebUrls(request);
    if (urls.length === 0)
      throw new Error('Jade HTTP request has no usable non-onion URL');

    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'POST')
      throw new Error(`Jade HTTP method is not supported: ${request.method}`);

    let lastError: unknown;
    for (const url of urls) {
      try {
        const headers = new Headers();
        if (request.accept) headers.set('Accept', request.accept);
        let body: BodyInit | undefined;
        if (method === 'POST' && request.data !== undefined) {
          if (
            typeof request.data === 'string' ||
            request.data instanceof Uint8Array
          ) {
            body =
              typeof request.data === 'string'
                ? request.data
                : new Uint8Array(request.data).buffer;
          } else {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(request.data);
          }
        }
        const response = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {})
        });
        if (!response.ok)
          throw new Error(
            `Jade HTTP request failed: ${response.status} ${response.statusText}`
          );
        const accept = request.accept?.toLowerCase() ?? '';
        if (accept.includes('json')) return { body: await response.json() };
        return { body: new Uint8Array(await response.arrayBuffer()) };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Jade HTTP request failed');
  };
