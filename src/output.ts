import { type LogSeverity, write } from "firebase-functions/logger";
import { settings } from "./options.js";

const SECRET_KEY = /password|secret|token|authorization|cookie|api[-_]?key/i;

// Token counts (prompt_tokens, inputTokens, promptTokenCount, ...) measure usage; they are not secrets.
const TOKEN_COUNT_KEY = /tokens$|token_?count$/i;

const TOKEN_DETAILS_KEY = /tokens_?details$/i;

function isSecretKey(key: string, value: unknown): boolean {
  if (!SECRET_KEY.test(key)) return false;
  if (typeof value === "number" && TOKEN_COUNT_KEY.test(key)) return false;
  if (typeof value === "object" && value !== null && TOKEN_DETAILS_KEY.test(key)) return false; // its own keys are judged on their own
  return true;
}

// Secrets that turn up inside values and messages, whatever the key is called.
const SECRET_PATTERNS: [RegExp, string | ((match: string) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED:private-key]"],
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, "[REDACTED:jwt]"],
  [/\b(Bearer)\s+[\w.~+/=-]{16,}/gi, "$1 [REDACTED]"],
  [
    /\b(?:[sr]k_(?:live|test)_|whsec_)[A-Za-z0-9]{8,}|\bsk-[\w-]{20,}|\bAIza[\w-]{35}|\bAKIA[0-9A-Z]{16}|\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_\w{22,}|\bxox[abprs]-[\w-]{10,}/g,
    "[REDACTED:key]",
  ],
  [/([?&](?:access_token|id_token|refresh_token|token|api_key|apikey|key|secret|signature|sig|password)=)[^&\s"']+/gi, "$1[REDACTED]"],
  [/\b\d(?:[ -]?\d){12,18}\b/g, (match) => (isCardNumber(match) ? "[REDACTED:card]" : match)],
];

// Visa, Mastercard, Amex, Discover and JCB. A prefix and the Luhn check keep timestamps and ids from matching.
const CARD_NUMBER = /^(?:4\d{12}(?:\d{3}){0,2}|5[1-5]\d{14}|2(?:2[2-9]\d|[3-6]\d\d|7[01]\d|720)\d{12}|3[47]\d{13}|6(?:011|5\d\d|4[4-9]\d)\d{12}|35(?:2[89]|[3-8]\d)\d{12})$/;

const SCAN_LIMIT = 100_000;

function isCardNumber(text: string): boolean {
  const digits = text.replace(/[ -]/g, "");
  if (!CARD_NUMBER.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (digit *= 2) > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

function redactString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement as string);
  for (const pattern of settings.secretPatterns) out = out.replace(pattern, "[REDACTED:custom]");
  return out;
}

const MAX_DEPTH = 5;

const MAX_STRING = 2000;

const MAX_ARRAY = 100;

const MAX_ENTRY_BYTES = 100_000; // Cloud Logging rejects entries over 256 KB

export const REPORTED_ERROR_EVENT = "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

// What an oversized entry keeps: enough to find and investigate the invocation.
const KEY_FIELDS = [
  "authUid",
  "actor",
  "auditEvent",
  "auditEvents",
  "securityEvent",
  "errorName",
  "errorCode",
  "fingerprint",
  "publicMessage",
  "retryable",
  "provider",
  "upstream",
  "durationMs",
  "sampleRate",
  "external",
  "llm",
  "coldStart",
  "httpRequest",
  "context",
];

function hasToJSON(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString(); // JSON.stringify throws on bigint
  if (typeof value === "string") {
    const text = redactString(value.length > SCAN_LIMIT ? value.slice(0, SCAN_LIMIT) : value); // redact before cutting
    return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]` : text;
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth > MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      // message, stack and cause are non-enumerable. toJSON (axios, HttpsError) is far smaller than the own fields.
      const { name, message, stack, cause } = value;
      const fields = hasToJSON(value) ? (value.toJSON() as object) : value;
      return sanitize({ ...fields, name, message, stack, cause }, depth, seen);
    }
    if (hasToJSON(value)) return sanitize(value.toJSON(), depth, seen); // Date, Timestamp, Buffer, ...
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1, seen));
      return value.length > MAX_ARRAY ? [...items, `[…${value.length - MAX_ARRAY} more]`] : items;
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isSecretKey(k, v) ? "[REDACTED]" : sanitize(v, depth + 1, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

/** One log entry, as written. Besides `severity` and `message` it has whatever the invocation gathered. */
export interface LogEntry {
  severity: LogSeverity;
  message: string;
  [field: string]: unknown;
}

/** Delivers an entry. Logging must never break the code being logged, so a failure here is swallowed. */
function deliver(entry: LogEntry): void {
  try {
    (settings.sink ?? write)(entry);
  } catch {}
}

export function emit(severity: LogSeverity, rawMessage: string, payload: object, extra: object = {}): void {
  const message = redactString(rawMessage);
  const entry: LogEntry = { ...(sanitize(payload) as Record<string, unknown>), ...extra, severity, message };
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  if (bytes <= MAX_ENTRY_BYTES) return deliver(entry);
  const kept = Object.fromEntries(KEY_FIELDS.filter((k) => k in entry).map((k) => [k, entry[k]]));
  deliver({ ...kept, ...extra, severity, message: message.slice(0, MAX_STRING), truncatedBytes: bytes });
}
