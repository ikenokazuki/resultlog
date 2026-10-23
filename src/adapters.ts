import type { CallableRequest, CallableResponse, Request, Response } from "firebase-functions/v2/https";
import type { AuthBlockingEvent } from "firebase-functions/v2/identity";
import { ok } from "neverthrow";
import type { input, output, ZodType } from "zod";
import { logContext } from "./context.js";
import { settle } from "./core.js";
import { EventInFlight, EventTooOld, httpStatus, InvalidInput, toHttpsError } from "./errors.js";
import type { IdempotencyStore } from "./idempotency.js";
import { type HandlerOptions, settings } from "./options.js";
import type { Outcome, Settled } from "./types.js";

/** Parses untrusted input with a zod schema; failures become a WARNING-level `invalid-argument`. */
async function parseInput<S extends ZodType>(schema: S, value: unknown): Promise<output<S>> {
  const parsed = await schema.safeParseAsync(value);
  if (parsed.success) return parsed.data;
  const { issues } = parsed.error;
  throw new InvalidInput("Invalid input", { context: { issues }, details: { issues } });
}

function splitArgs<F extends Function>(
  first: ZodType | F,
  second?: F | HandlerOptions,
  third?: HandlerOptions,
): [ZodType | undefined, F, HandlerOptions] {
  return typeof first === "function"
    ? [undefined, first, (second as HandlerOptions | undefined) ?? {}]
    : [first, second as F, third ?? {}];
}

/**
 * The client address as Express sees it, plus the raw X-Forwarded-For. Its left-most entries come from the client
 * and can be forged; the entries Google's front end appends on the right can be trusted.
 */
function requestActor(req: Request | undefined): Record<string, unknown> {
  return { ip: req?.ip, forwardedFor: req?.headers?.["x-forwarded-for"], userAgent: req?.headers?.["user-agent"] };
}

function callActor(request: CallableRequest): Record<string, unknown> {
  const token = request.auth?.token;
  return {
    uid: request.auth?.uid ?? null,
    signInProvider: token?.firebase?.sign_in_provider,
    authTime: typeof token?.auth_time === "number" ? new Date(token.auth_time * 1000).toISOString() : undefined,
    appId: request.app?.appId,
    // What App Check says about the call: a token it vouched for, none, or one that was used before (a replay).
    appCheck: request.app ? (request.app.alreadyConsumed ? "replayed" : "verified") : "missing",
    ...requestActor(request.rawRequest),
  };
}

/** The status of the response: 200 for a value, the error code's HTTP status for an error. */
const statusOf = (settled: Settled<unknown>) => (settled.ok ? 200 : httpStatus(settled.error.code));

type CallHandler<T> = (request: CallableRequest<any>, response?: CallableResponse) => Outcome<T>;

/**
 * For `onCall`. Ok → returned to the client; Err → `HttpsError(code, publicMessage)`.
 * With a zod schema, `request.data` is parsed (and typed) before `fn` runs.
 * `response` is the streaming response of `onCall` (`response.sendChunk`).
 */
export function wrapCall<T>(
  fn: (request: CallableRequest<unknown>, response?: CallableResponse) => Outcome<T>,
  options?: HandlerOptions,
): (request: CallableRequest, response?: CallableResponse) => Promise<T>;

export function wrapCall<S extends ZodType, T>(
  schema: S,
  fn: (request: CallableRequest<output<S>>, response?: CallableResponse) => Outcome<T>,
  options?: HandlerOptions,
): (request: CallableRequest<input<S>>, response?: CallableResponse) => Promise<T>;

export function wrapCall<T>(schemaOrFn: ZodType | CallHandler<T>, second?: CallHandler<T> | HandlerOptions, third?: HandlerOptions) {
  const [schema, fn, handler] = splitArgs(schemaOrFn, second, third);
  return async (request: CallableRequest, response?: CallableResponse): Promise<T> => {
    const settled = await settle(
      { authUid: request.auth?.uid ?? null },
      async () => {
        // A replayed token is recorded, not refused: refusing is your policy (or `enforceAppCheck`'s).
        if (request.app?.alreadyConsumed) {
          logContext.security("authn_token_reuse", { appId: request.app.appId }, { severity: "CRITICAL" });
        }
        return fn(schema ? { ...request, data: await parseInput(schema, request.data) } : request, response);
      },
      callActor(request),
      handler,
      {},
      { method: request.rawRequest?.method ?? "POST", path: request.rawRequest?.path, status: statusOf },
    );
    if (settled.ok) return settled.value;
    throw toHttpsError(settled.error);
  };
}

export interface BlockingOptions extends HandlerOptions {
  /**
   * What to do when the policy itself breaks (a thrown exception, a timeout): false, the default, denies the sign-in;
   * true lets it through and logs the failure. A denial the policy returns on purpose is always honoured.
   */
  failOpen?: boolean;
}

/**
 * For the Identity Platform blocking triggers `beforeUserSignedIn` and `beforeUserCreated` (they need the project to be
 * upgraded to Firebase Authentication with Identity Platform). Every sign-in that gets through is recorded as the
 * audit event `authn_login_success` (a sign-up as `user_created`) with the address, user agent and sign-in method, and
 * a denial is logged as the security event `authn_login_fail` unless the error names its own. `fn` returns what
 * Firebase accepts (custom claims, `disabled`, ...) or an `AppError` to deny. Firebase gives these functions 7 seconds,
 * so the timeout guard defaults to 7. They run after the credentials were verified: a failed password never gets here.
 */
export function wrapBlocking<R = void>(fn: (event: AuthBlockingEvent) => Outcome<R>, options: BlockingOptions = {}) {
  const { failOpen = false, ...handler } = options;
  return async (event: AuthBlockingEvent): Promise<R | undefined> => {
    const signUp = /beforeCreate/.test(event.eventType ?? "");
    const method = event.eventType?.includes(":") ? event.eventType.slice(event.eventType.lastIndexOf(":") + 1) : undefined;
    const settled = await settle(
      { eventId: event.eventId, eventType: event.eventType },
      async () => {
        const result = await fn(event);
        if (result.isOk()) logContext.audit(signUp ? "user_created" : "authn_login_success");
        return result;
      },
      { uid: event.data?.uid ?? null, signInProvider: method, locale: event.locale, ip: event.ipAddress, userAgent: event.userAgent },
      { timeoutSeconds: 7, ...handler }, // the platform's limit, whatever the global timeout says
      { securityEvent: "authn_login_fail" },
    );
    if (settled.ok) return settled.value;
    if (failOpen && settled.error.severity !== "WARNING") return undefined;
    throw toHttpsError(settled.error);
  };
}

type RequestHandler<T> = (req: Request, res: Response) => Outcome<T>;

/**
 * For `onRequest`. Ok → 200 JSON; Err → callable-style `{ error: { status, message } }`.
 * With a zod schema, `req.body` is parsed (and typed) before `fn` runs.
 */
export function wrapRequest<T>(fn: RequestHandler<T>, options?: HandlerOptions): (req: Request, res: Response) => Promise<void>;

export function wrapRequest<S extends ZodType, T>(
  schema: S,
  fn: (req: Request & { body: output<S> }, res: Response) => Outcome<T>,
  options?: HandlerOptions,
): (req: Request, res: Response) => Promise<void>;

export function wrapRequest<T>(schemaOrFn: ZodType | RequestHandler<T>, second?: RequestHandler<T> | HandlerOptions, third?: HandlerOptions) {
  const [schema, fn, handler] = splitArgs(schemaOrFn, second, third);
  return async (req: Request, res: Response): Promise<void> => {
    const settled = await settle(
      {},
      async () => {
        if (schema) req.body = await parseInput(schema, req.body);
        return fn(req, res);
      },
      requestActor(req),
      handler,
      {},
      { method: req.method, path: req.path, status: (settled) => (res.headersSent ? res.statusCode : statusOf(settled)) }, // a response the handler sent itself decides
    );
    if (res.headersSent) return; // the handler already responded
    if (settled.ok) {
      res.status(200).json(settled.value);
      return;
    }
    const error = toHttpsError(settled.error);
    res.status(error.httpErrorCode.status).json({ error: error.toJSON() });
  };
}

export interface EventOptions extends HandlerOptions {
  /** Acknowledge (log as WARNING, skip `fn`) events whose CloudEvent `time` is older than this, so retries end. */
  maxEventAgeMs?: number;
  /** Skip events that were processed already. See `firestoreIdempotency`. */
  idempotency?: IdempotencyStore;
  /** How long a claim blocks redeliveries. Defaults to the timeout plus 60 s (540 s without a configured timeout). */
  leaseMs?: number;
}

/**
 * For event triggers. A `retryable` error is rethrown so the trigger retries it; anything else is acknowledged.
 * The event type is not inferred through generic triggers: annotate it, e.g. `(event: CloudEvent<MessagePublishedData>)`.
 */
export function wrapEvent<E>(fn: (event: E) => Outcome<unknown>, eventOptions: EventOptions = {}) {
  const { maxEventAgeMs, idempotency, leaseMs, ...handler } = eventOptions;
  return async (event: E): Promise<void> => {
    const { id, type, time } = (event ?? {}) as { id?: unknown; type?: unknown; time?: unknown };
    const ageMs = typeof time === "string" ? Date.now() - Date.parse(time) : 0;
    const key = idempotency && typeof id === "string" ? `${process.env.K_SERVICE ?? "fn"}:${id.replaceAll("/", "_")}` : undefined;
    const settled = await settle(
      { eventId: id, eventType: type },
      async () => {
        if (maxEventAgeMs !== undefined && ageMs > maxEventAgeMs) {
          throw new EventTooOld(`Event is ${ageMs} ms old`, { context: { eventTime: time, maxEventAgeMs } });
        }
        if (!idempotency || !key) return fn(event);
        const lease = leaseMs ?? ((handler.timeoutSeconds ?? settings.timeoutSeconds ?? 540) * 1000 + 60_000);
        const claim = await idempotency.claim(key, lease);
        if (claim === "done") {
          logContext.set({ duplicate: true });
          return ok(undefined);
        }
        if (claim === "in-flight") throw new EventInFlight(`Event ${String(id)} is being processed by another instance`);
        // From here on the claim is ours: keep it if the event is dealt with, give it back if a retry should run.
        const settleClaim = (done: boolean, error?: unknown) =>
          (done ? idempotency.complete(key) : idempotency.release(key)).catch((e) =>
            logContext.error(e, { step: done ? "idempotency.complete" : "idempotency.release", cause: error }),
          );
        try {
          const result = await fn(event);
          await settleClaim(result.isOk() || !result.error.retryable);
          return result;
        } catch (e) {
          await settleClaim(false, e);
          throw e;
        }
      },
      {},
      handler,
    );
    if (!settled.ok && settled.error.retryable) throw settled.error;
  };
}
