import { type FunctionsErrorCode, HttpsError } from "firebase-functions/v2/https";

export type ErrorCode = Exclude<FunctionsErrorCode, "ok">;

export type Severity = "WARNING" | "ERROR" | "CRITICAL";

export interface AppErrorOptions {
  code: ErrorCode;
  /** Returned to the client. Defaults to the canonical status name, e.g. "NOT_FOUND". */
  publicMessage?: string;
  /** Defaults to "ERROR" for 5xx codes, "WARNING" otherwise. */
  severity?: Severity;
  /** Whether a failed event is retried (`wrapEvent` rethrows it). Defaults to `severity !== "WARNING"`. */
  retryable?: boolean;
  /**
   * Records this failure as a security event, with the actor, whatever the client is told: an OWASP Logging
   * Vocabulary name such as "authz_fail" or "malicious_direct_reference". Answer a stranger's request for someone
   * else's order with `not-found` and still log it as `authz_fail`. Without it, permission-denied and unauthenticated
   * count as "authz_fail"; `false` turns that off.
   */
  securityEvent?: string | false;
  context?: Record<string, unknown>;
  /** Sent to the client as `HttpsError.details`, for WARNING errors only. Never put secrets here. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  override name: string = "AppError";
  readonly code: ErrorCode;
  readonly severity: Severity;
  readonly retryable: boolean;
  readonly publicMessage: string;
  readonly context: Record<string, unknown>;
  readonly details?: Record<string, unknown>;
  readonly securityEvent?: string | false;

  constructor(message: string, opts: AppErrorOptions) {
    super(message, { cause: opts.cause });
    Error.captureStackTrace(this, new.target); // start the stack at the caller
    const { status, canonicalName } = new HttpsError(opts.code, "").httpErrorCode;
    this.code = opts.code;
    this.severity = opts.severity ?? (status >= 500 ? "ERROR" : "WARNING");
    this.retryable = opts.retryable ?? this.severity !== "WARNING";
    this.publicMessage = opts.publicMessage ?? canonicalName;
    this.context = { ...opts.context };
    this.details = opts.details;
    this.securityEvent = opts.securityEvent;
  }

  withContext(extra: Record<string, unknown>): this {
    Object.assign(this.context, extra);
    return this;
  }
}

export function defineError<N extends string>(name: N, defaults: Omit<AppErrorOptions, "context" | "cause">) {
  return class extends AppError {
    override name: N = name;
    constructor(message: string, opts: Pick<AppErrorOptions, "context" | "details" | "cause"> = {}) {
      super(message, { ...defaults, ...opts });
    }
  };
}

/** Raised when a zod schema rejects the input. Its `issues` reach the client in `details`. */
export class InvalidInput extends defineError("InvalidInput", { code: "invalid-argument", securityEvent: "input_validation_fail" }) {}

export class EventTooOld extends defineError("EventTooOld", { code: "deadline-exceeded", severity: "WARNING" }) {}

/** The timeout guard cut off an invocation that was about to run out of time. */
export class DeadlineExceeded extends defineError("DeadlineExceeded", { code: "deadline-exceeded" }) {}

/** Another instance holds a live claim on the event: retry later rather than skip it. */
export class EventInFlight extends defineError("EventInFlight", { code: "aborted", severity: "WARNING", retryable: true }) {}

/** The HTTP status that a callable or an HTTP function answers with for this code. */
export function httpStatus(code: ErrorCode): number {
  return new HttpsError(code, "").httpErrorCode.status;
}

/** Only WARNING (client-side) errors explain themselves to the client; server failures stay opaque. */
export function toHttpsError(error: AppError): HttpsError {
  if (error.severity !== "WARNING") return new HttpsError(error.code, error.publicMessage);
  const reason = error.name === "AppError" ? {} : { reason: error.name }; // only named errors have a reason worth sending
  const details = { ...reason, ...error.details };
  return new HttpsError(error.code, error.publicMessage, Object.keys(details).length > 0 ? details : undefined);
}
