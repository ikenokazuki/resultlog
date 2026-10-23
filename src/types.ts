import type { Result, ResultAsync } from "neverthrow";
import type { AppError } from "./errors.js";

// ResultAsync is listed explicitly: its `then` rejects `null`, so it is not assignable to PromiseLike<Result<T, AppError>> when E is a subclass.
export type Outcome<T, E extends AppError = AppError> = Result<T, E> | ResultAsync<T, E> | Promise<Result<T, E>>;

export type Settled<T> = { ok: true; value: T } | { ok: false; error: AppError };
