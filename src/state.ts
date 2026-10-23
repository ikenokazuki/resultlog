import { AsyncLocalStorage } from "node:async_hooks";
import type { HostStats } from "./calls.js";
import type { LlmTotals } from "./llm.js";
import type { Settled } from "./types.js";

export interface Breadcrumb {
  timestamp: string;
  level: "DEBUG" | "NOTICE";
  message: string;
  data?: Record<string, unknown>;
}

/** The HTTP request an invocation answers: a callable or an HTTP function, not an event. */
export interface HttpInfo {
  method?: string;
  /** The path only: a query string can hold secrets. */
  path?: string;
  /** The status the response gets, known once the outcome is. */
  status: (settled: Settled<unknown>) => number;
}

export interface Store {
  start: number;
  attrs: Record<string, unknown>;
  crumbs: Breadcrumb[];
  /** Who made the request. Written on audit and security entries, and on every entry with `configure({ actor: "all" })`. */
  actor: Record<string, unknown>;
  auditEvents: string[];
  securityEvents: string[];
  /** Aborts when the timeout guard fires. */
  signal: AbortSignal;
  /** `performance.now()` at which the guard fires, when a timeout is configured. */
  deadlineAt?: number;
  /** Outgoing HTTP calls, by host. */
  calls: Map<string, HostStats>;
  /** What the LLM calls of this invocation used. */
  llm?: LlmTotals;
  /** The request this invocation answers, when it answers one. */
  http?: HttpInfo;
}

export const als = new AsyncLocalStorage<Store>();

/** An actor with nothing in it (an event, or a request that carries no address) is left out of the entry. */
export function hasActor(actor: Record<string, unknown>): boolean {
  return Object.values(actor).some((value) => value !== undefined && value !== null);
}

// Becomes LogEntry.labels: cheap to match in sinks, log-based metrics and alerts.
export const LABELS = "logging.googleapis.com/labels";
