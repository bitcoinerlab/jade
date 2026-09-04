export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message: string
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Jade timeout must be a positive integer');

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
