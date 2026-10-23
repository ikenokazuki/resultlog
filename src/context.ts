import { llm } from "./llm.js";
import { emit } from "./output.js";
import { als, type Breadcrumb, hasActor, LABELS } from "./state.js";

const MAX_CRUMBS = 50;

function addCrumb(level: Breadcrumb["level"], message: string, data?: Record<string, unknown>): void {
  const crumbs = als.getStore()?.crumbs;
  if (crumbs && crumbs.push({ timestamp: new Date().toISOString(), level, message, data }) > MAX_CRUMBS) {
    crumbs.shift();
  }
}

export const logContext = {
  /**
   * Aborts when the timeout guard is about to cut the invocation off. Pass it to fetch and SDK calls so they stop
   * too. Undefined outside a wrapped handler.
   */
  get signal(): AbortSignal | undefined {
    return als.getStore()?.signal;
  },
  /**
   * Records an LLM call: tokens, model and finish reason are read from the response, whatever SDK it came from. Pass
   * numbers as the second argument for anything it can't read. Given a stream, it returns the same chunks and also
   * records the time to the first one and whether the stream was cut short. No-op outside a wrapped handler.
   */
  llm,
  /** Adds attributes to this invocation's single log entry. No-op outside a wrapped handler. */
  set(attrs: Record<string, unknown>): void {
    const store = als.getStore();
    if (store) Object.assign(store.attrs, attrs);
  },
  /** Buffers a breadcrumb that is logged only if the invocation fails. No-op outside a wrapped handler. */
  debug(message: string, data?: Record<string, unknown>): void {
    addCrumb("DEBUG", message, data);
  },
  /** Records an error you recovered from under `handledErrors`; the invocation still succeeds. No-op outside a wrapped handler. */
  error(error: unknown, data?: Record<string, unknown>): void {
    const store = als.getStore();
    if (store) ((store.attrs.handledErrors ??= []) as unknown[]).push({ ...data, error });
  },
  /** Adds to who made the request, e.g. a uid you verified yourself in `onRequest`. No-op outside a wrapped handler. */
  setActor(fields: Record<string, unknown>): void {
    const store = als.getStore();
    if (store) Object.assign(store.actor, fields);
  },
  /**
   * Writes an audit entry (NOTICE) immediately, even outside a wrapped handler. The invocation's final entry lists
   * it again with the outcome. Prefer OWASP Logging Vocabulary names such as "authz_change" or "sensitive_read".
   */
  audit(event: string, data?: Record<string, unknown>): void {
    const store = als.getStore();
    store?.auditEvents.push(event);
    addCrumb("NOTICE", event, data);
    emit("NOTICE", event, { ...store?.attrs, ...data, auditEvent: event, ...actorOf(store) }, { [LABELS]: { audit: "true" } });
  },
  /**
   * Records a security event (an OWASP Logging Vocabulary name such as "sensitive_read", "authz_fail" or
   * "malicious_direct_reference") at once, with the actor and the label `security`, even outside a wrapped handler.
   * It is for places where nothing fails but something deserves a trail. To answer a request with a harmless error
   * and still record it, declare `securityEvent` on the error instead: record an event one way or the other, not
   * both. The invocation's final entry lists it under `securityEvents`.
   */
  security(
    event: string,
    data?: Record<string, unknown>,
    options: { severity?: "NOTICE" | "WARNING" | "ERROR" | "CRITICAL" } = {},
  ): void {
    const store = als.getStore();
    store?.securityEvents.push(event);
    addCrumb("NOTICE", event, data);
    emit(options.severity ?? "WARNING", event, { ...store?.attrs, ...data, securityEvent: event, ...actorOf(store) }, { [LABELS]: { security: event } });
  },
};

const actorOf = (store: { actor: Record<string, unknown> } | undefined) => (store && hasActor(store.actor) ? { actor: store.actor } : {});
