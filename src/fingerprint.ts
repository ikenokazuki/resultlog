import { createHash } from "node:crypto";
import type { AppError } from "./errors.js";
import { ExternalError } from "./external.js";

/** "    at findUser (/srv/src/users.ts:12:5)" becomes "findUser (users.ts)": no path, no line, so a deploy doesn't change it. */
function topFrame(stack: string | undefined): string {
  const line = stack?.split("\n").find((l) => /^\s+at\s/.test(l));
  const match = line?.match(/^\s+at\s+(?:async\s+)?(?:(.*?)\s+\()?([^()\s]+?):\d+:\d+\)?\s*$/);
  if (!match) return "";
  const file = match[2]?.split("/").pop() ?? "";
  return match[1] ? `${match[1]} (${file})` : `(${file})`;
}

/**
 * A short id for "this kind of failure": the same for every occurrence, whatever ids or numbers its message holds.
 * Built from the error's name and code, where it was raised, and for an upstream failure the provider and the class
 * of the status (5xx), so that 500 and 503 count as one. Use it to group failures, in a digest or a log query.
 */
export function fingerprint(error: AppError): string {
  const upstream = error instanceof ExternalError ? [error.provider, `${Math.floor((error.upstream.status ?? 0) / 100)}xx`] : [];
  const parts = [error.name, error.code, ...upstream, topFrame(error.stack)];
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}
