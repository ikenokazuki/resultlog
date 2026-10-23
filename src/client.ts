// For the browser or an app: no import from the server side, so nothing of firebase-admin comes along.

export interface ClientIssue {
  path: (string | number)[];
  message: string;
  code?: string;
}

/** A failed call, as a screen needs it. */
export interface ClientError {
  /** The Firebase error code without its prefix: "not-found", "invalid-argument", ... */
  code: string;
  /** The name of the error on the server, such as "EmailTaken": pick the text to show by it. Named errors only. */
  reason?: string;
  /** The server's public message. For an error that wasn't named, that is the status name, such as "INTERNAL". */
  message: string;
  /** Whatever else the server sent in `details`. */
  details: Record<string, unknown>;
  /** What zod objected to, from `InvalidInput`. */
  issues: ClientIssue[];
  /** The same, as messages per field ("address.zip"), for a form. Errors about the form as a whole are under "_form". */
  fieldErrors: Record<string, string[]>;
  /** True for the failures that can go away by themselves: unavailable, deadline-exceeded, resource-exhausted, aborted. */
  retryable: boolean;
}

const RETRYABLE = new Set(["unavailable", "deadline-exceeded", "resource-exhausted", "aborted"]);

function build(code: string, message: string, details: unknown): ClientError {
  const { reason, issues, ...rest } = (typeof details === "object" && details !== null && !Array.isArray(details) ? details : {}) as Record<string, unknown>;
  const list = (Array.isArray(issues) ? issues : []).filter((i): i is ClientIssue => typeof i === "object" && i !== null && Array.isArray((i as ClientIssue).path));
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of list) {
    const field = issue.path.length > 0 ? issue.path.join(".") : "_form";
    (fieldErrors[field] ??= []).push(String(issue.message));
  }
  return {
    code,
    reason: typeof reason === "string" ? reason : undefined,
    message,
    details: rest,
    issues: list,
    fieldErrors,
    retryable: RETRYABLE.has(code),
  };
}

/** The error the Firebase SDK throws when a callable function fails (its code reads "functions/not-found"). */
export function parseError(error: unknown): ClientError {
  const e = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof e.code === "string" && e.code.startsWith("functions/") ? e.code.slice("functions/".length) : undefined;
  if (code === undefined) return build("unknown", typeof e.message === "string" ? e.message : String(error ?? "Unknown error"), undefined);
  return build(code, typeof e.message === "string" ? e.message : code, e.details);
}

/** The JSON body an `onRequest` function wrapped by `wrapRequest` answers with: `{ error: { status, message, details } }`. */
export function parseErrorBody(body: unknown): ClientError {
  const error = (typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined) as
    | { status?: unknown; message?: unknown; details?: unknown }
    | undefined;
  if (typeof error !== "object" || error === null || typeof error.status !== "string") return build("unknown", "Unknown error", undefined);
  const code = error.status.toLowerCase().replaceAll("_", "-");
  return build(code, typeof error.message === "string" ? error.message : code, error.details);
}
