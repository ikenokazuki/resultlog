import { isIP } from "node:net";
import { HttpsError } from "firebase-functions/v2/https";
import { summarizeCalls, watchRequests } from "./calls.js";
import { AppError, DeadlineExceeded, httpStatus } from "./errors.js";
import { fingerprint } from "./fingerprint.js";
import { summarizeLlm } from "./llm.js";
import { type HandlerOptions, settings } from "./options.js";
import { emit, REPORTED_ERROR_EVENT } from "./output.js";
import { als, type HttpInfo, hasActor, LABELS, type Store } from "./state.js";
import type { Outcome, Settled } from "./types.js";

function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof HttpsError && e.code !== "ok") {
    const details = typeof e.details === "object" && e.details !== null ? (e.details as Record<string, unknown>) : undefined;
    return new AppError(e.message, { code: e.code, publicMessage: e.message, details, cause: e });
  }
  const error = new AppError(e instanceof Error ? e.message : String(e), { code: "internal", cause: e });
  if (e instanceof Error && e.stack) error.stack = e.stack; // group in Error Reporting by the original throw site
  return error;
}

let coldStart = true;

/** For tests: makes the next invocation a cold start again, or not. Not part of the public API. */
export function setColdStart(value: boolean): void {
  coldStart = value;
}

export interface Defaults {
  /** The security event for a policy denial (a WARNING error) that doesn't declare its own, instead of the one derived from its code. */
  securityEvent?: string;
}

export async function settle<T>(
  attrs: Record<string, unknown>,
  fn: () => Outcome<T> | Promise<Outcome<T>>,
  actor: Record<string, unknown> = {},
  handler: HandlerOptions = {},
  defaults: Defaults = {},
  http?: HttpInfo,
): Promise<Settled<T>> {
  watchRequests();
  const timeoutSeconds = handler.timeoutSeconds ?? settings.timeoutSeconds;
  const marginMs = handler.timeoutMarginMs ?? settings.timeoutMarginMs;
  const guardMs = timeoutSeconds === undefined ? undefined : Math.max(0, timeoutSeconds * 1000 - marginMs);
  const start = performance.now();
  const controller = new AbortController();
  const store: Store = {
    start,
    attrs: { ...attrs },
    crumbs: [],
    actor: { ...actor },
    auditEvents: [],
    securityEvents: [],
    signal: controller.signal,
    deadlineAt: guardMs === undefined ? undefined : start + guardMs,
    calls: new Map(),
    http,
  };
  if (coldStart) {
    coldStart = false;
    store.attrs.coldStart = true;
  }
  return als.run(store, async () => {
    let settled: Settled<T>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = (async () => fn())();
      running.catch(() => {}); // if the guard wins, a later failure of the handler must not become an unhandled rejection
      const guard =
        guardMs === undefined
          ? []
          : [
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  const error = new DeadlineExceeded(`Stopped ${marginMs} ms before the ${timeoutSeconds} s timeout`, {
                    context: { timeoutSeconds, marginMs },
                  });
                  controller.abort(error);
                  reject(error);
                }, guardMs);
                (timer as { unref?: () => void }).unref?.(); // the guard must never keep the process alive
              }),
            ];
      const result = await Promise.race([running, ...guard]);
      settled = result.isOk() ? { ok: true, value: result.value } : { ok: false, error: toAppError(result.error) };
    } catch (e) {
      settled = { ok: false, error: toAppError(e) };
    } finally {
      clearTimeout(timer);
    }
    finish(store, settled, defaults);
    return settled;
  });
}

/** What a log viewer shows for a success: which function, that it worked, how long it took. */
const okMessage = (durationMs: number) => [process.env.K_SERVICE, "ok", `${durationMs} ms`].filter(Boolean).join(" ");

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * The `httpRequest` field of a log entry. Cloud Logging shows it as method, status and latency, and filters on it
 * (`httpRequest.status>=500`). The address and user agent are the actor's: they appear only where the actor does.
 */
function httpRequestOf(store: Store, http: HttpInfo, settled: Settled<unknown>, durationMs: number, withActor: boolean) {
  const ip = text(store.actor.ip);
  return {
    requestMethod: http.method,
    requestUrl: http.path,
    status: http.status(settled),
    latency: `${(durationMs / 1000).toFixed(3)}s`,
    // A forged X-Forwarded-For can make req.ip anything. This field is typed, so only an address goes in; the actor keeps the raw value.
    remoteIp: withActor && ip !== undefined && isIP(ip) !== 0 ? ip : undefined,
    userAgent: withActor ? text(store.actor.userAgent) : undefined,
  };
}

/** The user and the request an error belongs to, in the fields Error Reporting documents for them (`ReportedErrorEvent.context`). */
function reportContextOf(store: Store, request: ReturnType<typeof httpRequestOf> | undefined) {
  const user = text(store.actor.uid);
  if (user === undefined && request === undefined) return {};
  const httpRequest = request && {
    method: request.requestMethod,
    url: request.requestUrl,
    responseStatusCode: request.status,
    userAgent: request.userAgent,
    remoteIp: request.remoteIp,
  };
  return { context: { user, httpRequest } };
}

/** Writes the invocation's single entry, unless a successful run is sampled away. */
function finish(store: Store, settled: Settled<unknown>, defaults: Defaults): void {
  const durationMs = Math.round(performance.now() - store.start);
  const audited = store.auditEvents.length > 0;
  const secured = store.securityEvents.length > 0;
  const labels: Record<string, string> = audited ? { audit: "true" } : {};
  const external = summarizeCalls(store);
  /** The entries that say who: audit and security entries always, every entry when asked. */
  const showsActor = (securityEvent?: string) => audited || secured || securityEvent !== undefined || settings.actor === "all";
  const trailOf = (securityEvent?: string) => ({
    ...(audited ? { auditEvents: store.auditEvents } : {}),
    ...(secured ? { securityEvents: store.securityEvents } : {}),
    ...(showsActor(securityEvent) && hasActor(store.actor) ? { actor: store.actor } : {}),
  });
  const requestOf = (securityEvent?: string) => store.http && httpRequestOf(store, store.http, settled, durationMs, showsActor(securityEvent) && hasActor(store.actor));
  if (settled.ok) {
    const alwaysKept =
      audited ||
      secured ||
      durationMs >= settings.slowMs ||
      "handledErrors" in store.attrs ||
      "coldStart" in store.attrs ||
      store.attrs.duplicate === true ||
      (store.llm !== undefined && store.llm.truncated + store.llm.blocked + store.llm.interrupted > 0);
    const rate = settings.successSampleRate;
    if (!alwaysKept && Math.random() >= rate) return;
    const sampleRate = !alwaysKept && rate < 1 ? { sampleRate: rate } : {};
    const httpRequest = requestOf();
    emit(
      "INFO",
      okMessage(durationMs),
      { ...store.attrs, ...trailOf(), ...external, ...summarizeLlm(store), ...(httpRequest ? { httpRequest } : {}), durationMs, ...sampleRate },
      audited ? { [LABELS]: labels } : {},
    );
    return;
  }
  const e = settled.error;
  // Declared by the error, else the default of the caller (for a policy denial only), else derived from the code.
  const securityEvent =
    e.securityEvent === false
      ? undefined
      : (e.securityEvent ??
        (e.severity === "WARNING" ? defaults.securityEvent : undefined) ??
        (e.code === "unauthenticated" || e.code === "permission-denied" ? "authz_fail" : undefined));
  if (securityEvent) labels.security = securityEvent;
  const httpRequest = requestOf(securityEvent);
  const payload = {
    ...store.attrs,
    ...e.context,
    ...trailOf(securityEvent),
    ...external,
    ...summarizeLlm(store),
    ...(securityEvent ? { securityEvent } : {}),
    ...(httpRequest ? { httpRequest } : {}),
    ...(e.severity === "WARNING" ? {} : reportContextOf(store, httpRequest)),
    errorName: e.name,
    errorCode: e.code,
    fingerprint: fingerprint(e),
    publicMessage: e.publicMessage,
    retryable: e.retryable,
    durationMs,
    breadcrumbs: store.crumbs,
    cause: e.cause,
  };
  const extra = Object.keys(labels).length > 0 ? { [LABELS]: labels } : {};
  if (e.severity === "WARNING") emit("WARNING", e.message, payload, extra);
  else emit(e.severity, e.stack ?? e.message, payload, { ...extra, "@type": REPORTED_ERROR_EVENT });
}
