import { AppError, type AppErrorOptions } from "./errors.js";

/** What an upstream failure looked like, small enough to log. */
export interface Upstream {
  status?: number;
  code?: string | number;
  type?: string;
  /** Quote this to the provider's support. */
  requestId?: string;
  retryAfterMs?: number;
}

export type ExternalClassification = Partial<
  Pick<AppErrorOptions, "code" | "severity" | "retryable" | "publicMessage" | "details" | "context">
>;

export class ExternalError<P extends string = string> extends AppError {
  override name = "ExternalError";
  readonly provider: P;
  readonly upstream: Upstream;

  constructor(message: string, provider: P, upstream: Upstream, opts: AppErrorOptions) {
    super(message, { ...opts, context: { ...opts.context, provider, upstream } });
    this.provider = provider;
    this.upstream = upstream;
  }
}

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
]);

// gRPC status numbers (Firestore and other Google Cloud clients) use the same canonical names as FunctionsErrorCode.
const GRPC_CODES = [
  undefined,
  "cancelled",
  "unknown",
  "invalid-argument",
  "deadline-exceeded",
  "not-found",
  "already-exists",
  "permission-denied",
  "resource-exhausted",
  "failed-precondition",
  "aborted",
  "out-of-range",
  "unimplemented",
  "internal",
  "unavailable",
  "data-loss",
  "unauthenticated",
] as const;

const GRPC_RETRYABLE = new Set([4, 8, 10, 13, 14]);

const GRPC_OUR_FAULT = new Set([3, 7, 11, 16]); // our request or our credentials are wrong

function classifyUpstream(e: Record<string, any>, { status, code }: Upstream): ExternalClassification {
  const errno = String(e.cause?.code ?? e.code ?? "");
  if (e.name === "TimeoutError" || e.name === "AbortError" || TIMEOUT_CODES.has(errno) || status === 408 || status === 504) {
    return { code: "deadline-exceeded", retryable: true };
  }
  if (status === 429) return { code: "resource-exhausted", severity: "WARNING", retryable: true };
  if (status !== undefined) {
    // 5xx: the provider failed. Other 4xx: our request or our credentials are wrong, so retrying won't help.
    return status >= 500 ? { code: "unavailable", retryable: true } : { code: "internal", retryable: false };
  }
  const grpc = typeof code === "number" ? GRPC_CODES[code] : undefined;
  if (grpc) {
    return GRPC_OUR_FAULT.has(code as number)
      ? { code: "internal", retryable: false }
      : { code: grpc, retryable: GRPC_RETRYABLE.has(code as number) };
  }
  if (NETWORK_CODES.has(errno) || (e instanceof TypeError && e.message === "fetch failed")) {
    return { code: "unavailable", retryable: true };
  }
  return { code: "internal" };
}

/**
 * Turns an upstream failure (an SDK error, fetch, axios, gRPC, or a non-ok fetch `Response`) into an
 * `ExternalError` with a code, severity and retryability. `classify` overrides that for provider-specific errors.
 */
export function toExternalError<P extends string>(
  provider: P,
  error: unknown,
  classify?: (error: unknown, upstream: Upstream) => ExternalClassification | undefined,
): ExternalError<P> {
  const e = (typeof error === "object" && error !== null ? error : {}) as Record<string, any>;
  const headers = e.headers ?? e.response?.headers;
  const header = (name: string): string | undefined =>
    (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) ?? undefined;
  const status = [e.status, e.statusCode, e.response?.status].find((s): s is number => typeof s === "number");
  const retryAfter = Number(header("retry-after"));
  const upstream: Upstream = {
    status,
    // DOMException's numeric `code` is a legacy constant (TimeoutError is 23), not a gRPC status.
    code: error instanceof DOMException ? undefined : (e.code ?? e.cause?.code ?? e.error?.code),
    type: e.type ?? e.error?.error?.type ?? e.error?.type,
    requestId: e.requestId ?? e.requestID ?? e.request_id ?? header("x-request-id") ?? header("request-id"),
    retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
  };
  const detail = typeof e.message === "string" && e.message ? e.message : status ? `HTTP ${status}` : String(error);
  const external = new ExternalError(`${provider}: ${detail}`, provider, upstream, {
    code: "internal",
    ...classifyUpstream(e, upstream),
    ...classify?.(error, upstream),
    cause: error,
  });
  Error.captureStackTrace(external, toExternalError); // start at the call site, so Error Reporting groups by it
  return external;
}
