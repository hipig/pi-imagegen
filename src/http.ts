export interface HttpRequestOptions {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  signal?: AbortSignal;
  timeoutMs: number;
  maxAttempts: number;
  maxBytes: number;
  label: string;
}

export interface BinaryResponse {
  data: Buffer;
  contentType?: string;
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Response is ${contentLength} bytes, exceeding the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

function apiErrorMessage(body: Buffer): string | undefined {
  if (body.length === 0) return undefined;
  const text = body.toString("utf8").trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
      if (typeof record.message === "string") return record.message;
    }
  } catch {
    // Fall back to a bounded plain-text message.
  }
  return text.slice(0, 2_000);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.min(Math.max(0, timestamp - Date.now()), 60_000);
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function performRequest(options: HttpRequestOptions): Promise<BinaryResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason;

    try {
      const response = await options.fetch(options.url, {
        ...options.init,
        signal: combineSignal(options.signal, options.timeoutMs),
      });
      const body = await readLimitedBody(response, options.maxBytes);

      if (response.ok) {
        return {
          data: body,
          contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
        };
      }

      const detail = apiErrorMessage(body);
      const error = new HttpStatusError(
        `${options.label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
        retryAfterMs(response),
      );
      lastError = error;
      if (!isRetryableStatus(response.status) || attempt === options.maxAttempts) throw error;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof HttpStatusError && !isRetryableStatus(error.status)) throw error;
      if (attempt === options.maxAttempts) {
        if (isAbort(error)) throw new Error(`${options.label} timed out after ${options.timeoutMs}ms.`);
        throw error;
      }
    }

    const retryDelay =
      lastError instanceof HttpStatusError && lastError.retryAfterMs !== undefined
        ? lastError.retryAfterMs
        : Math.min(2 ** attempt * 1_000, 30_000);
    await delay(retryDelay, options.signal);
  }

  throw lastError instanceof Error ? lastError : new Error(`${options.label} failed.`);
}

export async function requestJson<T>(options: HttpRequestOptions): Promise<T> {
  const response = await performRequest(options);
  try {
    return JSON.parse(response.data.toString("utf8")) as T;
  } catch (error) {
    throw new Error(
      `${options.label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function requestBinary(options: HttpRequestOptions): Promise<BinaryResponse> {
  return performRequest(options);
}
