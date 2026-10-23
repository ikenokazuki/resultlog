import { err, type Result, ResultAsync } from "neverthrow";
import { type AttemptScope, attemptScope, countRequest, watchRequests } from "./calls.js";
import { logContext } from "./context.js";
import type { AppError } from "./errors.js";
import { ExternalError } from "./external.js";
import { als } from "./state.js";
import type { Outcome } from "./types.js";

/** Providers whose SDKs retry by themselves. Add yours with declaration merging. */
export interface SelfRetryingProviders {
  stripe: true;
  openai: true;
  anthropic: true;
}

type SelfRetrying<E> = E extends ExternalError<infer P> ? (Lowercase<P> extends keyof SelfRetryingProviders ? P : never) : never;

type DoubleRetryGuard<E, O> = [SelfRetrying<E>] extends [never]
  ? unknown
  : O extends { sdkRetriesDisabled: true }
    ? unknown
    : `${SelfRetrying<E>}'s SDK already retries this call. Set its own retries to 0 and pass { sdkRetriesDisabled: true }, or remove retry().`;

export interface RetryOptions {
  /** Attempts in total, the first one included. */
  attempts?: number;
  /** Upper bound of the first backoff (ms). It doubles each attempt; the wait is random below it (full jitter). */
  baseDelayMs?: number;
  /** Longest single wait (ms). A longer Retry-After stops retrying instead. */
  maxDelayMs?: number;
  /** Stop when the next wait would end more than this many ms after the first attempt started. */
  budgetMs?: number;
  /** You set the SDK's own retries to 0, so a provider in SelfRetryingProviders may be retried here. */
  sdkRetriesDisabled?: boolean;
  /** The call repeats the same request on purpose (polling), so repeats are not an internal retry. */
  allowRepeatedRequests?: boolean;
}

function recordRetry(summary: Record<string, unknown>): void {
  const store = als.getStore();
  if (store) ((store.attrs.retries ??= []) as unknown[]).push(summary);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Retries `fn` while it fails with a `retryable` error: waits Retry-After when given, otherwise a jittered
 * exponential backoff, within `budgetMs`. It never stacks on another retry layer. If one attempt sent the same HTTP
 * request twice, something inside (an SDK, axios-retry, a nested retry()) already retried: it stops there, and in
 * tests and the emulator it throws so you notice.
 */
export function retry<T, E extends AppError, const O extends RetryOptions = {}>(
  fn: (() => Outcome<T, E>) & NoInfer<DoubleRetryGuard<E, O>>,
  options?: O,
): ResultAsync<T, E> {
  const { attempts = 3, baseDelayMs = 200, maxDelayMs = 2000, budgetMs = 5000, allowRepeatedRequests = false } = options ?? {};
  watchRequests();
  const started = performance.now();
  const parent = attemptScope.getStore();
  const store = als.getStore();
  const run = async (): Promise<Result<T, E>> => {
    // Past the deadline the handler has been answered for already: don't start more work.
    if (store?.signal.aborted) return err(store.signal.reason as E);
    let waitedMs = 0;
    for (let attempt = 1; ; attempt++) {
      countRequest("retry() attempt", parent); // a nested retry() looks like a repeated request to its caller
      const scope: AttemptScope = { requests: new Map(), parent };
      const result = await attemptScope.run(scope, async () => fn());
      const repeated = allowRepeatedRequests ? undefined : [...scope.requests].find(([, count]) => count > 1);
      const done = (stoppedBy?: string) => {
        // Worth a record: it retried, something inside retried, or it wanted to retry but could not.
        if (attempt > 1 || repeated || (stoppedBy !== undefined && stoppedBy !== "not-retryable")) {
          recordRetry({
            attempts: attempt,
            waitedMs: Math.round(waitedMs),
            outcome: result.isOk() ? "ok" : result.error.code,
            ...(stoppedBy ? { stoppedBy } : {}),
            ...(repeated ? { repeatedRequest: { request: repeated[0], count: repeated[1] } } : {}),
          });
        }
        return result;
      };
      if (repeated) {
        if (process.env.FUNCTIONS_EMULATOR === "true" || process.env.NODE_ENV === "test") {
          throw new Error(
            `retry() wraps a call that already retried internally: ${repeated[0]} was sent ${repeated[1]} times in one attempt. ` +
              "Remove retry(), turn the inner retries off, or pass { allowRepeatedRequests: true } if the repeats are intended.",
          );
        }
        return done(result.isOk() ? undefined : "internal-retry");
      }
      if (result.isOk()) return done();
      if (!result.error.retryable) return done("not-retryable");
      if (attempt >= attempts) return done("attempts");
      const retryAfterMs = result.error instanceof ExternalError ? result.error.upstream.retryAfterMs : undefined;
      if (retryAfterMs !== undefined && retryAfterMs > maxDelayMs) return done("retry-after");
      const delay = retryAfterMs ?? Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const remainingMs = store?.deadlineAt === undefined ? Infinity : store.deadlineAt - performance.now();
      if (delay >= remainingMs) return done("timeout"); // the timeout guard would cut the wait off
      if (performance.now() - started + delay > budgetMs) return done("budget");
      logContext.debug("retrying", { attempt, waitMs: Math.round(delay), errorCode: result.error.code });
      await sleep(delay, store?.signal);
      waitedMs += delay;
      if (store?.signal.aborted) return done("timeout");
    }
  };
  return new ResultAsync(run());
}

type OutcomeOk<F> = F extends () => infer R ? (Awaited<R> extends Result<infer T, unknown> ? T : never) : never;

type OutcomeErr<F> = F extends () => infer R ? (Awaited<R> extends Result<unknown, infer E> ? E : never) : never;

/**
 * Tries the attempts in turn. It moves on only when the failure is `retryable`, meaning the provider is at fault: a
 * request that is itself wrong would be refused by the next one too. Each attempt it leaves is recorded as a handled
 * error, and once the timeout guard has fired it starts nothing more. The last attempt's result is returned as is.
 * The attempts may fail with different error types, as calls to different providers do.
 */
export function fallback<const A extends readonly [() => Outcome<any, AppError>, ...(() => Outcome<any, AppError>)[]]>(
  ...attempts: A
): ResultAsync<OutcomeOk<A[number]>, OutcomeErr<A[number]>>;

export function fallback(...attempts: (() => Outcome<unknown>)[]): ResultAsync<unknown, AppError> {
  const store = als.getStore();
  const run = async (): Promise<Result<unknown, AppError>> => {
    let result!: Result<unknown, AppError>;
    for (const [index, attempt] of attempts.entries()) {
      result = await attempt();
      if (result.isOk() || !result.error.retryable || index === attempts.length - 1 || store?.signal.aborted) return result;
      logContext.error(result.error, { fallback: index });
    }
    return result;
  };
  return new ResultAsync(run());
}
