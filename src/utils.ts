/**
 * Utility functions for Arke agents
 */

/**
 * Sleep for the specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 *
 * @param fn - Function to retry
 * @param maxRetries - Maximum number of retries
 * @param baseDelayMs - Base delay in milliseconds (doubles each retry)
 * @returns Result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error('Retry failed');
}

/**
 * Create a timeout promise that rejects after the specified duration.
 */
export function createTimeout(ms: number, message?: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message ?? `Timeout after ${ms}ms`));
    }, ms);
  });
}

/**
 * Race a promise against a timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string
): Promise<T> {
  return Promise.race([promise, createTimeout(ms, message)]);
}

/**
 * Chunk an array into smaller arrays of the specified size.
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Create a deferred promise with external resolve/reject.
 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Generate a simple unique ID.
 */
export function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
