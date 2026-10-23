import type { LlmCall } from "./llm.js";
import type { LogEntry } from "./output.js";

export interface LogOptions {
  /** Share (0–1) of successful invocations that are logged. Failures, slow runs, audits, handled errors, duplicates and cold starts are always kept. */
  successSampleRate?: number;
  /** Successful invocations at least this slow (ms) are always logged. */
  slowMs?: number;
  /**
   * Your functions' timeout in seconds, as given to `setGlobalOptions`. The platform doesn't expose it, so say it
   * here to turn the timeout guard on. A handler's own `timeoutSeconds` overrides it.
   */
  timeoutSeconds?: number;
  /** The guard steps in this long (ms) before the timeout, leaving time to write the entry and to answer. Default 1000. */
  timeoutMarginMs?: number;
  /** Summarize outgoing HTTP calls per host in each entry. Default true. */
  recordExternalCalls?: boolean;
  /** Further secret patterns to redact, on top of the built-in ones. */
  secretPatterns?: RegExp[];
  /**
   * Prices one LLM call, in whatever unit you like, for `llm.cost` in the entry. resultlog ships no price list: prices
   * change, and yours may differ. Return undefined for a call you can't price.
   */
  price?: (call: LlmCall) => number | undefined;
  /**
   * Which entries carry the actor (who made the request: uid, address, user agent, App Check state). "security"
   * (the default) puts it on audit and security entries only, which keeps ordinary entries small and personal data
   * out of them. "all" puts it on every entry, so that a digest can see one account used from many addresses, or one
   * address across many accounts, in ordinary traffic. It adds about 100 to 250 bytes to each entry.
   */
  actor?: "security" | "all";
  /**
   * Receives every entry instead of the platform logger: to capture entries in a test (see `captureLogs` in
   * `resultlog/testing`), or to write them somewhere else. A sink that throws is ignored.
   */
  sink?: (entry: LogEntry) => void;
}

/** Per-handler timeout settings. They override the ones from `configure`. */
export interface HandlerOptions {
  timeoutSeconds?: number;
  timeoutMarginMs?: number;
}

export const settings = {
  successSampleRate: 1,
  slowMs: 1000,
  timeoutSeconds: undefined as number | undefined,
  timeoutMarginMs: 1000,
  recordExternalCalls: true,
  price: undefined as LogOptions["price"],
  /** `LogOptions.secretPatterns`, compiled to global regular expressions. */
  secretPatterns: [] as RegExp[],
  sink: undefined as LogOptions["sink"],
  actor: "security" as "security" | "all",
};

/** Sets process-wide logging options. Call it once when the module loads. */
export function configure({ secretPatterns, ...rest }: LogOptions): void {
  Object.assign(settings, rest);
  if (secretPatterns) settings.secretPatterns = secretPatterns.map((p) => (p.global ? p : new RegExp(p.source, `${p.flags}g`)));
}
