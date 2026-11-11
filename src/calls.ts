import { AsyncLocalStorage } from "node:async_hooks";
import { channel, subscribe } from "node:diagnostics_channel";
import { settings } from "./options.js";
import { als, type Store } from "./state.js";

/** What an attempt did with one request, named by its key: the method, the origin and the path with its query. */
interface SentRequest {
  sent: number;
  /** The latest answer was a failure, so sending the same request now is a retry. */
  failed: boolean;
  /** It was sent again after a failure. */
  retried: boolean;
}

export interface AttemptScope {
  requests: Map<string, SentRequest>;
  parent?: AttemptScope;
}

export const attemptScope = new AsyncLocalStorage<AttemptScope>();

// Held for the module's lifetime: Bun drops a subscription once its channel object is garbage-collected.
const watchedChannels: unknown[] = [];

/**
 * Notes that a request was sent, in an attempt and in every attempt that encloses it. The same request sent after one
 * that failed is a retry that something inside the attempt does by itself. The same request sent again after it worked
 * is not: two prompts to one model endpoint, or two calls to a JSON-RPC API with a single URL, look alike but are
 * different work.
 */
export function noteSent(key: string, scope: AttemptScope | undefined): void {
  for (let s = scope; s; s = s.parent) {
    const seen = s.requests.get(key) ?? { sent: 0, failed: false, retried: false };
    seen.sent++;
    if (seen.failed) seen.retried = true;
    s.requests.set(key, seen);
  }
}

/** Notes how a request was answered. A failure makes the next identical request a retry. */
export function noteAnswer(key: string, scope: AttemptScope | undefined, failed: boolean): void {
  for (let s = scope; s; s = s.parent) {
    const seen = s.requests.get(key);
    if (seen) seen.failed = failed;
  }
}

/**
 * The request an attempt sent again after a failure, and how often it sent it. The query string is left out: it can
 * hold a secret, and the entry should say as little about the path as `external` does (only the host).
 */
export function retriedRequest(scope: AttemptScope): { request: string; count: number } | undefined {
  for (const [key, seen] of scope.requests) {
    if (seen.retried) return { request: key.replace(/\?.*$/, ""), count: seen.sent };
  }
  return undefined;
}

/** The answers that make a client send a request again: no answer, a timeout, a conflict, throttling, or a server failure. */
const isRetriable = (status: number | undefined) =>
  status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;

export interface HostStats {
  calls: number;
  errors: number;
  statuses: Record<string, number>;
  totalMs: number;
  maxMs: number;
}

const MAX_HOSTS = 20;

// Token fetches by the platform itself: on every cold start, and of no use to someone reading an entry.
const IGNORED_HOSTS = new Set(["metadata.google.internal", "169.254.169.254"]);

const tracked = new WeakMap<object, { key: string; scope?: AttemptScope; stats?: HostStats; start: number }>();

function hostOf(origin: unknown): string {
  try {
    return new URL(String(origin)).host;
  } catch {
    return String(origin);
  }
}

function requestStarted(request: object, method: string, origin: string, host: string, path: string): void {
  const key = `${method} ${origin}${path}`;
  const scope = attemptScope.getStore();
  noteSent(key, scope); // whether or not the calls are summarized: the check for stacked retries must not depend on it
  const store = als.getStore();
  let stats: HostStats | undefined;
  if (store && settings.recordExternalCalls && !IGNORED_HOSTS.has(host.replace(/:\d+$/, ""))) {
    stats = store.calls.get(host);
    if (!stats && store.calls.size < MAX_HOSTS) {
      stats = { calls: 0, errors: 0, statuses: {}, totalMs: 0, maxMs: 0 };
      store.calls.set(host, stats);
    }
    if (stats) stats.calls++;
  }
  if (scope || stats) tracked.set(request, { key, scope, stats, start: performance.now() });
}

function requestEnded(request: object, status?: number): void {
  const call = tracked.get(request);
  if (!call) return;
  tracked.delete(request); // only the first outcome counts
  noteAnswer(call.key, call.scope, isRetriable(status));
  const { stats } = call;
  if (!stats) return;
  const ms = performance.now() - call.start;
  stats.totalMs += ms;
  stats.maxMs = Math.max(stats.maxMs, ms);
  if (status === undefined) stats.errors++;
  else stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
}

/** Per host: calls, errors, response statuses and the time until the response headers arrived. */
export function summarizeCalls(store: Store): { external?: Record<string, unknown> } {
  if (store.calls.size === 0) return {};
  const external = [...store.calls].map(([host, stats]) => {
    const answered = Object.values(stats.statuses).reduce((sum, n) => sum + n, 0);
    const pending = stats.calls - stats.errors - answered; // no answer yet: a hung call shows up here
    return [
      host,
      {
        calls: stats.calls,
        statuses: stats.statuses,
        ...(stats.errors > 0 ? { errors: stats.errors } : {}),
        ...(pending > 0 ? { pending } : {}),
        totalMs: Math.round(stats.totalMs),
        maxMs: Math.round(stats.maxMs),
      },
    ];
  });
  return { external: Object.fromEntries(external) };
}

/**
 * Observes every outgoing HTTP request, from fetch and from the http module (axios, the Stripe SDK), without
 * patching either. A subscriber that throws would crash the process, so none is allowed to.
 */
export function watchRequests(): void {
  if (watchedChannels.length > 0) return;
  const on = (name: string, handler: (message: any) => void) => {
    watchedChannels.push(channel(name));
    subscribe(name, (message) => {
      try {
        handler(message);
      } catch {}
    });
  };
  on("undici:request:create", ({ request: r }) => requestStarted(r, r.method, String(r.origin), hostOf(r.origin), r.path));
  on("undici:request:headers", ({ request, response }) => requestEnded(request, response.statusCode));
  on("undici:request:error", ({ request }) => requestEnded(request));
  // The Host header carries the port when it isn't the default, which matches what fetch reports.
  on("http.client.request.start", ({ request: r }) =>
    requestStarted(r, r.method, `${r.protocol}//${r.host}`, String(r.getHeader?.("host") ?? r.host), r.path),
  );
  on("http.client.response.finish", ({ request, response }) => requestEnded(request, response.statusCode));
  on("http.client.request.error", ({ request }) => requestEnded(request));
}
