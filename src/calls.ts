import { AsyncLocalStorage } from "node:async_hooks";
import { channel, subscribe } from "node:diagnostics_channel";
import { settings } from "./options.js";
import { als, type Store } from "./state.js";

export interface AttemptScope {
  requests: Map<string, number>;
  parent?: AttemptScope;
}

export const attemptScope = new AsyncLocalStorage<AttemptScope>();

// Held for the module's lifetime: Bun drops a subscription once its channel object is garbage-collected.
const watchedChannels: unknown[] = [];

/** Counts a request into an attempt and every attempt that encloses it. */
export function countRequest(key: string, scope = attemptScope.getStore()): void {
  for (let s = scope; s; s = s.parent) s.requests.set(key, (s.requests.get(key) ?? 0) + 1);
}

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

const tracked = new WeakMap<object, { stats: HostStats; start: number }>();

function hostOf(origin: unknown): string {
  try {
    return new URL(String(origin)).host;
  } catch {
    return String(origin);
  }
}

function requestStarted(request: object, method: string, origin: string, host: string, path: string): void {
  countRequest(`${method} ${origin}${path}`);
  const store = als.getStore();
  if (!store || !settings.recordExternalCalls || IGNORED_HOSTS.has(host.replace(/:\d+$/, ""))) return;
  let stats = store.calls.get(host);
  if (!stats) {
    if (store.calls.size >= MAX_HOSTS) return;
    stats = { calls: 0, errors: 0, statuses: {}, totalMs: 0, maxMs: 0 };
    store.calls.set(host, stats);
  }
  stats.calls++;
  tracked.set(request, { stats, start: performance.now() });
}

function requestEnded(request: object, status?: number): void {
  const call = tracked.get(request);
  if (!call) return;
  tracked.delete(request); // only the first outcome counts
  const ms = performance.now() - call.start;
  call.stats.totalMs += ms;
  call.stats.maxMs = Math.max(call.stats.maxMs, ms);
  if (status === undefined) call.stats.errors++;
  else call.stats.statuses[status] = (call.stats.statuses[status] ?? 0) + 1;
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
