import type { Result, ResultAsync } from "neverthrow";
import type { AppError } from "./errors.js";

/**
 * What a handler may return. An error that is not an `AppError` is accepted as well and treated as a thrown exception
 * is (ERROR, `internal`, its own name), so a `Result<T, Error>` from code that knows nothing of resultlog works as it is.
 * `retry` and `fallback` read the code and retryability of an error, so they ask for an `AppError`.
 */
// ResultAsync is listed explicitly: its `then` rejects `null`, so it is not assignable to PromiseLike<Result<T, Error>> when E is a subclass.
export type Outcome<T, E extends Error = Error> = Result<T, E> | ResultAsync<T, E> | Promise<Result<T, E>>;

export type Settled<T> = { ok: true; value: T } | { ok: false; error: AppError };
