import type { CloudEvent } from "firebase-functions/v2";
import type { CallableRequest, Request, Response } from "firebase-functions/v2/https";
import type { AuthBlockingEvent } from "firebase-functions/v2/identity";
import { configure, settings } from "./options.js";
import type { LogEntry } from "./output.js";

export interface CapturedLogs {
  /** The entries written since `captureLogs()` (or the last `clear()`), oldest first. */
  readonly entries: LogEntry[];
  clear(): void;
  /** Puts the previous sink back. Call it in `afterEach`. */
  restore(): void;
}

/** Collects the entries resultlog writes, so that a test can assert on what a handler logged. */
export function captureLogs(): CapturedLogs {
  const previous = settings.sink;
  const entries: LogEntry[] = [];
  configure({ sink: (entry) => void entries.push(entry) });
  return {
    entries,
    clear: () => void (entries.length = 0),
    restore: () => configure({ sink: previous }),
  };
}

/**
 * A callable request, signed in as `uid` when given. `app` is what App Check vouched for (`alreadyConsumed: true` is a
 * replayed token); without it the call has no App Check token.
 */
export function callableRequest<T = unknown>(
  data: T = {} as T,
  {
    uid,
    token = {},
    ip = "127.0.0.1",
    app,
  }: { uid?: string; token?: Record<string, unknown>; ip?: string; app?: { appId: string; alreadyConsumed?: boolean } } = {},
): CallableRequest<T> {
  return {
    data,
    auth: uid ? { uid, token } : undefined,
    app,
    rawRequest: { method: "POST", path: "/", ip, headers: { "user-agent": "test" } },
    acceptsStreaming: false,
  } as unknown as CallableRequest<T>;
}

/** An Identity Platform blocking event for `wrapBlocking`: a sign-in by default; use an `eventType` ending in `beforeCreate:<provider>` for a sign-up. */
export function authBlockingEvent({
  uid = "user-1",
  ipAddress = "127.0.0.1",
  userAgent = "test",
  eventType = "providers/cloud.auth/eventTypes/user.beforeSignIn:password",
  eventId = "auth-evt-1",
}: { uid?: string; ipAddress?: string; userAgent?: string; eventType?: string; eventId?: string } = {}): AuthBlockingEvent {
  return {
    eventId,
    eventType,
    ipAddress,
    userAgent,
    timestamp: new Date(),
    locale: "en",
    authType: "USER",
    resource: { service: "identitytoolkit.googleapis.com", name: "projects/demo" },
    data: { uid, email: `${uid}@example.com` },
  } as unknown as AuthBlockingEvent;
}

/** A request and a response for `wrapRequest`; `sent` records what the handler answered. */
export function httpExchange({
  method = "GET",
  path = "/",
  body,
  headers = {},
}: { method?: string; path?: string; body?: unknown; headers?: Record<string, string> } = {}): {
  req: Request;
  res: Response;
  sent: { status?: number; body?: unknown };
} {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    statusCode: 200,
    status(code: number) {
      sent.status = code;
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      sent.body = payload;
      res.headersSent = true;
      return res;
    },
    send(payload: unknown) {
      sent.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader() {
      return res;
    },
  };
  const req = { method, path, body, headers: { "user-agent": "test", ...headers }, ip: "127.0.0.1" };
  return { req: req as unknown as Request, res: res as unknown as Response, sent };
}

/** A CloudEvent for `wrapEvent`, with the id and time a real trigger delivers. */
export function cloudEvent<T>(
  data: T,
  { id = "evt-1", type = "test.event", source = "//test", time = new Date().toISOString() }: Partial<CloudEvent<T>> = {},
): CloudEvent<T> {
  return { specversion: "1.0", id, type, source, time, data } as CloudEvent<T>;
}
