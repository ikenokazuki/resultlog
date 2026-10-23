import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import dc from "node:diagnostics_channel";
import { setColdStart } from "./core.js";
import { authBlockingEvent, captureLogs, callableRequest, cloudEvent, httpExchange } from "./testing.js";
import * as realLogger from "firebase-functions/logger";
import {
  type CallableRequest,
  type CallableResponse,
  HttpsError,
  onCall,
  type Request,
  type Response,
} from "firebase-functions/v2/https";
import type { CloudEvent } from "firebase-functions/v2";
import { type MessagePublishedData, onMessagePublished } from "firebase-functions/v2/pubsub";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

// Capture every log entry instead of printing it. Must run before ./index is loaded.
const writes: Record<string, any>[] = [];
mock.module("firebase-functions/logger", () => ({
  ...realLogger,
  write: (entry: Record<string, any>) => void writes.push(entry),
}));
const {
  AppError,
  configure,
  defineError,
  fallback,
  firestoreIdempotency,
  logContext,
  retry,
  toExternalError,
  wrapBlocking,
  wrapCall,
  wrapEvent,
  wrapRequest,
} = await import("./index");

const UserNotFound = defineError("UserNotFound", { code: "not-found", publicMessage: "見つかりません" });
const DbError = defineError("DbError", { code: "internal" });
const callRequest = (data: unknown = {}) => ({ data, auth: { uid: "u1" } }) as unknown as CallableRequest;
const IdInput = z.object({ id: z.string().trim().min(1) });
// The first invocation of an instance is a cold start, which is always logged. Use it up here, so that no test
// depends on running first.
await wrapCall(() => okAsync(undefined))(callRequest());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const publish = (channel: string, message: object) => dc.channel(channel).publish(message);

beforeEach(() => {
  writes.length = 0;
  configure({
    successSampleRate: 1,
    slowMs: 1000,
    timeoutSeconds: undefined,
    timeoutMarginMs: 1000,
    recordExternalCalls: true,
    secretPatterns: [],
    price: undefined,
    sink: undefined,
    actor: "security",
  });
});

describe("AppError", () => {
  test("5xx codes default to ERROR and a canonical public message", () => {
    const e = new AppError("db exploded", { code: "internal" });
    expect(e.severity).toBe("ERROR");
    expect(e.publicMessage).toBe("INTERNAL");
    expect(e.message).toBe("db exploded");
  });

  test("4xx codes default to WARNING", () => {
    const e = new AppError("no such doc", { code: "not-found" });
    expect(e.severity).toBe("WARNING");
    expect(e.publicMessage).toBe("NOT_FOUND");
  });

  test("transient server codes are ERROR", () => {
    expect(new AppError("x", { code: "unavailable" }).severity).toBe("ERROR");
  });

  test("retryable follows severity unless set", () => {
    expect(new AppError("x", { code: "internal" }).retryable).toBe(true);
    expect(new AppError("x", { code: "not-found" }).retryable).toBe(false);
    expect(new AppError("x", { code: "resource-exhausted", retryable: true }).retryable).toBe(true);
  });

  test("explicit severity wins", () => {
    expect(new AppError("x", { code: "not-found", severity: "CRITICAL" }).severity).toBe("CRITICAL");
  });
});

describe("defineError", () => {
  const UserNotFound = defineError("UserNotFound", { code: "not-found", publicMessage: "見つかりません" });

  test("returns a named AppError subclass", () => {
    const cause = new Error("missing");
    const e = new UserNotFound("users/1 missing", { cause, context: { id: 1 } });
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(UserNotFound);
    expect(e.name).toBe("UserNotFound");
    expect(e.code).toBe("not-found");
    expect(e.publicMessage).toBe("見つかりません");
    expect(e.cause).toBe(cause);
    expect(e.context).toEqual({ id: 1 });
  });

  test("withContext merges into the same instance", () => {
    const e = new UserNotFound("x", { context: { a: 1 } });
    expect(e.withContext({ b: 2 })).toBe(e);
    expect(e.context).toEqual({ a: 1, b: 2 });
  });
});

describe("wrapCall", () => {
  test("Ok writes exactly one INFO wide event and drops breadcrumbs", async () => {
    const value = await wrapCall(() => {
      logContext.set({ plan: "pro" });
      logContext.debug("not shown on success");
      return okAsync({ id: 1 });
    })(callRequest());
    expect(value).toEqual({ id: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ severity: "INFO", message: expect.stringMatching(/ok \d+ ms$/), authUid: "u1", plan: "pro" });
    expect(typeof writes[0].durationMs).toBe("number");
    expect(writes[0].breadcrumbs).toBeUndefined();
  });

  test("WARNING: client gets the public message, the log gets details and breadcrumbs", async () => {
    const call = wrapCall(() => {
      logContext.set({ userId: "x" });
      logContext.debug("looked up", { col: "users" });
      return errAsync(new UserNotFound("users/x missing in firestore", { context: { col: "users" } }));
    });
    await expect(call(callRequest())).rejects.toMatchObject({ code: "not-found", message: "見つかりません" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      severity: "WARNING",
      message: "users/x missing in firestore",
      userId: "x",
      col: "users",
      errorName: "UserNotFound",
      errorCode: "not-found",
      breadcrumbs: [{ level: "DEBUG", message: "looked up", data: { col: "users" } }],
    });
    expect(writes[0]["@type"]).toBeUndefined();
  });

  test("ERROR: stack as message plus Error Reporting @type; the client only sees INTERNAL", async () => {
    const call = wrapCall(() => errAsync(new DbError("users read failed", { cause: new Error("ETIMEDOUT") })));
    await expect(call(callRequest())).rejects.toMatchObject({ code: "internal", message: "INTERNAL" });
    const [entry] = writes;
    expect(entry.severity).toBe("ERROR");
    expect(entry["@type"]).toBe("type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent");
    expect(entry.message).toContain("users read failed");
    expect(entry.message).toContain("\n    at ");
    expect(entry.cause).toMatchObject({ name: "Error", message: "ETIMEDOUT" });
    expect(entry.cause.stack).toContain("ETIMEDOUT");
  });

  test("a thrown Error becomes internal and keeps the original stack", async () => {
    const boom = new Error("boom");
    const call = wrapCall(() => {
      throw boom;
    });
    await expect(call(callRequest())).rejects.toMatchObject({ code: "internal", message: "INTERNAL" });
    expect(writes[0]).toMatchObject({ severity: "ERROR", errorCode: "internal", message: boom.stack });
  });

  test("a thrown HttpsError keeps its code and details, without an unnamed reason", async () => {
    const call = wrapCall(() => {
      throw new HttpsError("permission-denied", "nope", { scope: "admin" });
    });
    const error = (await call(callRequest()).catch((e: HttpsError) => e)) as HttpsError;
    expect(error).toMatchObject({ code: "permission-denied", message: "nope" });
    expect(error.details).toEqual({ scope: "admin" });
    expect(writes[0]).toMatchObject({ severity: "WARNING", errorCode: "permission-denied" });
  });

  test("concurrent invocations keep their own attributes and breadcrumbs", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
    const call = wrapCall(z.object({ n: z.number() }), async (request) => {
      const { n } = request.data;
      await tick();
      logContext.set({ n });
      await tick();
      logContext.debug(`step ${n}`);
      await tick();
      return n === 2 ? err(new DbError(`fail ${n}`)) : ok(n);
    });
    await Promise.allSettled([1, 2, 3].map((n) => call(callRequest({ n }))));
    expect(writes.map((w) => w.n).sort()).toEqual([1, 2, 3]);
    const failed = writes.find((w) => w.severity === "ERROR");
    expect(failed?.n).toBe(2);
    expect(failed?.breadcrumbs.map((c: { message: string }) => c.message)).toEqual(["step 2"]);
  });

  test("token counts are not mistaken for secrets, tokens are", async () => {
    await wrapCall(() => {
      logContext.set({
        maxTokens: 1000,
        max_tokens: 5,
        promptTokenCount: 3,
        usage: { prompt_tokens_details: { cached_tokens: 2 }, total_tokens: 9 },
        token: "abc",
        accessToken: "x",
        refresh_token: "y",
        tokens: ["device-token-1"],
        otpToken: 123456,
      });
      return okAsync(1);
    })(callRequest());
    expect(writes[0]).toMatchObject({
      maxTokens: 1000,
      max_tokens: 5,
      promptTokenCount: 3,
      usage: { prompt_tokens_details: { cached_tokens: 2 }, total_tokens: 9 },
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      refresh_token: "[REDACTED]",
      tokens: "[REDACTED]",
      otpToken: "[REDACTED]",
    });
  });

  test("secrets are redacted, cycles and bigints made safe, Dates written as ISO strings", async () => {
    const cyclic: Record<string, unknown> = { label: "c" };
    cyclic.self = cyclic;
    const when = new Date("2026-01-01T00:00:00Z");
    await wrapCall(() => {
      logContext.set({
        user: { password: "p", profile: { accessToken: "t", Authorization: "a", api_key: "k", visible: "yes" } },
        cyclic,
        big: 10n,
        when,
      });
      return okAsync(1);
    })(callRequest());
    expect(writes[0]).toMatchObject({
      user: {
        password: "[REDACTED]",
        profile: { accessToken: "[REDACTED]", Authorization: "[REDACTED]", api_key: "[REDACTED]", visible: "yes" },
      },
      cyclic: { label: "c", self: "[Circular]" },
      big: "10",
    });
    expect(writes[0].when).toBe("2026-01-01T00:00:00.000Z");
  });

  test("a zod schema parses request.data before the handler runs", async () => {
    const call = wrapCall(IdInput, (request) => okAsync(request.data.id));
    await expect(call(callRequest({ id: "  abc " }))).resolves.toBe("abc");
  });

  test("invalid input is rejected as invalid-argument without running the handler", async () => {
    let ran = false;
    const call = wrapCall(IdInput, () => {
      ran = true;
      return okAsync(1);
    });
    await expect(call(callRequest({ id: 1 }))).rejects.toMatchObject({
      code: "invalid-argument",
      message: "INVALID_ARGUMENT",
      details: { reason: "InvalidInput", issues: [expect.objectContaining({ path: ["id"] })] },
    });
    expect(ran).toBe(false);
    expect(writes[0]).toMatchObject({
      severity: "WARNING",
      errorName: "InvalidInput",
      errorCode: "invalid-argument",
      securityEvent: "input_validation_fail",
      issues: [expect.objectContaining({ path: ["id"] })],
    });
  });

  test("WARNING errors tell the client their reason and public details", async () => {
    const EmailTaken = defineError("EmailTaken", { code: "already-exists" });
    const call = wrapCall(() => errAsync(new EmailTaken("dup email", { details: { field: "email" } })));
    await expect(call(callRequest())).rejects.toMatchObject({
      code: "already-exists",
      details: { reason: "EmailTaken", field: "email" },
    });
  });

  test("ERROR errors send nothing but the public message", async () => {
    const call = wrapCall(() => errAsync(new DbError("db down", { details: { host: "10.0.0.1" } })));
    const error = await call(callRequest()).catch((e: HttpsError) => e);
    expect(error).toMatchObject({ code: "internal", message: "INTERNAL" });
    expect((error as HttpsError).details).toBeUndefined();
  });

  test("the streaming response is passed through to the handler", async () => {
    const chunks: unknown[] = [];
    const response = { sendChunk: async (chunk: unknown) => chunks.push(chunk) > 0 } as unknown as CallableResponse;
    const call = wrapCall(async (_request, res) => {
      await res?.sendChunk("partial");
      return ok("done");
    });
    await expect(call(callRequest(), response)).resolves.toBe("done");
    expect(chunks).toEqual(["partial"]);
  });

  test("breadcrumbs keep only the latest 50", async () => {
    await wrapCall(() => {
      for (let i = 1; i <= 60; i++) logContext.debug(`d${i}`);
      return errAsync(new UserNotFound("x"));
    })(callRequest()).catch(() => {});
    expect(writes[0].breadcrumbs).toHaveLength(50);
    expect(writes[0].breadcrumbs[0].message).toBe("d11");
  });
});

describe("logContext", () => {
  test("audit writes NOTICE immediately and is kept as a breadcrumb", async () => {
    await wrapCall(() => {
      logContext.set({ by: "admin" });
      logContext.audit("role changed", { role: "owner" });
      expect(writes).toHaveLength(1); // written before the handler finishes
      return errAsync(new UserNotFound("later failure"));
    })(callRequest()).catch(() => {});
    expect(writes[0]).toMatchObject({ severity: "NOTICE", message: "role changed", by: "admin", role: "owner" });
    expect(writes[1].breadcrumbs).toEqual([expect.objectContaining({ level: "NOTICE", message: "role changed" })]);
  });

  test("error() records a recovered error without failing the invocation", async () => {
    await wrapCall(() => {
      logContext.error(new Error("cache down"), { step: "cache" });
      return okAsync(1);
    })(callRequest());
    expect(writes[0]).toMatchObject({
      severity: "INFO",
      handledErrors: [{ step: "cache", error: { name: "Error", message: "cache down" } }],
    });
  });

  test("audit still writes outside a wrapped handler", () => {
    logContext.audit("outside");
    expect(writes).toEqual([expect.objectContaining({ severity: "NOTICE", message: "outside" })]);
  });

  test("set and debug are no-ops outside a wrapped handler", () => {
    logContext.set({ a: 1 });
    logContext.debug("x");
    expect(writes).toHaveLength(0);
  });
});

describe("wrapRequest", () => {
  const httpRequest = { method: "POST", path: "/users" } as unknown as Request;
  const fakeResponse = () => {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        res.headersSent = true;
        return res;
      },
    };
    return res;
  };

  test("Ok responds 200 with the value as JSON", async () => {
    const res = fakeResponse();
    await wrapRequest(() => okAsync({ id: 1 }))(httpRequest, res as unknown as Response);
    expect(res).toMatchObject({ statusCode: 200, body: { id: 1 } });
    expect(writes[0]).toMatchObject({ severity: "INFO", httpRequest: { requestMethod: "POST", requestUrl: "/users", status: 200 } });
    expect(writes[0]).not.toHaveProperty("method"); // httpRequest says it
    expect(writes[0]).not.toHaveProperty("path");
  });

  test("Err responds with the mapped HTTP status and a callable-style body", async () => {
    const res = fakeResponse();
    await wrapRequest(() => errAsync(new UserNotFound("users/x missing")))(httpRequest, res as unknown as Response);
    expect(res).toMatchObject({
      statusCode: 404,
      body: { error: { status: "NOT_FOUND", message: "見つかりません", details: { reason: "UserNotFound" } } },
    });
  });

  test("a zod schema validates req.body", async () => {
    const handler = wrapRequest(IdInput, (req) => okAsync(req.body.id));
    const good = fakeResponse();
    await handler({ ...httpRequest, body: { id: " x " } } as Request, good as unknown as Response);
    expect(good.body).toBe("x");
    const bad = fakeResponse();
    await handler({ ...httpRequest, body: {} } as Request, bad as unknown as Response);
    expect(bad).toMatchObject({ statusCode: 400, body: { error: { status: "INVALID_ARGUMENT" } } });
  });

  test("does not respond twice when the handler already responded", async () => {
    const res = fakeResponse();
    await wrapRequest((_req, r) => {
      r.status(201).json({ created: true });
      return okAsync(undefined);
    })(httpRequest, res as unknown as Response);
    expect(res).toMatchObject({ statusCode: 201, body: { created: true } });
  });
});

describe("wrapEvent", () => {
  const event = { id: "e1", type: "google.cloud.pubsub.topic.v1.messagePublished" };

  test("WARNING is acknowledged, so the event is not retried", async () => {
    await expect(wrapEvent(() => errAsync(new UserNotFound("bad payload")))(event)).resolves.toBeUndefined();
    expect(writes[0]).toMatchObject({ severity: "WARNING", eventId: "e1", eventType: event.type });
  });

  test("events older than maxEventAgeMs are acknowledged without running the handler", async () => {
    let ran = false;
    const handler = wrapEvent(
      () => {
        ran = true;
        return okAsync(undefined);
      },
      { maxEventAgeMs: 60_000 },
    );
    await expect(handler({ ...event, time: new Date(Date.now() - 120_000).toISOString() })).resolves.toBeUndefined();
    expect(ran).toBe(false);
    expect(writes[0]).toMatchObject({ severity: "WARNING", errorName: "EventTooOld", eventId: "e1" });

    await handler({ ...event, time: new Date().toISOString() });
    expect(ran).toBe(true);
  });

  test("retryable, not severity, decides whether the event is retried", async () => {
    const throttled = new AppError("slow down", { code: "resource-exhausted", retryable: true });
    await expect(wrapEvent(() => errAsync(throttled))(event)).rejects.toBe(throttled);
    const bug = new AppError("bad mapping", { code: "internal", retryable: false });
    await expect(wrapEvent(() => errAsync(bug))(event)).resolves.toBeUndefined();
    expect(writes.map((w) => w.retryable)).toEqual([true, false]);
  });

  test("ERROR is rethrown so retries apply", async () => {
    const failure = new DbError("db down");
    await expect(wrapEvent(() => errAsync(failure))(event)).rejects.toBe(failure);
    expect(writes[0].severity).toBe("ERROR");
  });
});

describe("with real triggers", () => {
  test("onCall(wrapCall(fn)) runs through the callable wrapper", async () => {
    const fn = onCall(wrapCall(IdInput, (request) => okAsync(request.data.id.toUpperCase())));
    await expect(fn.run(callRequest({ id: "abc" }))).resolves.toBe("ABC");
  });

  test("onMessagePublished(wrapEvent(fn)) runs through the event wrapper", async () => {
    const fn = onMessagePublished(
      "orders",
      wrapEvent((event: CloudEvent<MessagePublishedData>) => okAsync(event.data.message.messageId)),
    );
    await fn.run({ id: "e1", type: "t", data: { message: { messageId: "m1" } } } as never);
    expect(writes[0]).toMatchObject({ severity: "INFO", eventId: "e1" });
  });
});

describe("log size and shape", () => {
  const logOnce = (attrs: Record<string, unknown>) =>
    wrapCall(() => {
      logContext.set(attrs);
      return okAsync(1);
    })(callRequest());

  test("objects are written through toJSON, or as their own fields", async () => {
    class Money {
      amount = 500;
      toJSON() {
        return `${this.amount} JPY`;
      }
    }
    class Point {
      x = 1;
      y = 2;
    }
    await logOnce({ price: new Money(), at: new Point() });
    expect(writes[0]).toMatchObject({ price: "500 JPY", at: { x: 1, y: 2 } });
  });

  test("long strings and arrays are cut", async () => {
    await logOnce({ text: "a".repeat(2500), list: Array.from({ length: 120 }, (_, i) => i) });
    expect(writes[0].text).toBe(`${"a".repeat(2000)}…[+500 chars]`);
    expect(writes[0].list).toHaveLength(101);
    expect(writes[0].list.at(-1)).toBe("[…20 more]");
  });

  test("an entry over the size budget keeps only its key fields", async () => {
    await logOnce(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, "x".repeat(1500)])));
    expect(writes[0]).toMatchObject({ severity: "INFO", message: expect.stringMatching(/ok \d+ ms$/), authUid: "u1", httpRequest: { status: 200 } });
    expect(writes[0].truncatedBytes).toBeGreaterThan(100_000);
    expect(writes[0].k0).toBeUndefined();
  });
});

describe("sampling", () => {
  test("successful runs can be sampled away while failures are always logged", async () => {
    configure({ successSampleRate: 0 });
    await wrapCall(() => okAsync(1))(callRequest());
    expect(writes).toHaveLength(0);
    await wrapCall(() => errAsync(new UserNotFound("x")))(callRequest()).catch(() => {});
    expect(writes).toHaveLength(1);
  });

  test("slow runs, audits and handled errors are always logged", async () => {
    configure({ successSampleRate: 0, slowMs: 5 });
    await wrapCall(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok(1);
    })(callRequest());
    await wrapCall(() => {
      logContext.audit("sensitive_read");
      return okAsync(1);
    })(callRequest());
    await wrapCall(() => {
      logContext.error(new Error("cache down"));
      return okAsync(1);
    })(callRequest());
    const finals = writes.filter((w) => w.severity === "INFO");
    expect(finals).toHaveLength(3);
    expect(finals.every((w) => w.sampleRate === undefined)).toBe(true);
  });

  test("sampled entries record their sample rate", async () => {
    configure({ successSampleRate: 0.5 });
    const random = spyOn(Math, "random").mockReturnValue(0.1);
    try {
      await wrapCall(() => okAsync(1))(callRequest());
    } finally {
      random.mockRestore();
    }
    expect(writes[0].sampleRate).toBe(0.5);
  });
});

describe("security and audit", () => {
  const signedIn = {
    data: {},
    auth: { uid: "u1", token: { firebase: { sign_in_provider: "password" }, auth_time: 1_700_000_000 } },
    app: { appId: "1:123:web:abc" },
    rawRequest: {
      ip: "203.0.113.5",
      headers: { "user-agent": "curl/8.0", "x-forwarded-for": "198.51.100.1, 203.0.113.5" },
    },
  } as unknown as CallableRequest;

  test("permission denials are logged as authz_fail with the actor", async () => {
    await wrapCall(() => {
      throw new HttpsError("permission-denied", "admins only");
    })(signedIn).catch(() => {});
    expect(writes[0]).toMatchObject({
      severity: "WARNING",
      securityEvent: "authz_fail",
      "logging.googleapis.com/labels": { security: "authz_fail" },
      actor: {
        uid: "u1",
        signInProvider: "password",
        authTime: "2023-11-14T22:13:20.000Z",
        appId: "1:123:web:abc",
        ip: "203.0.113.5",
        forwardedFor: "198.51.100.1, 203.0.113.5",
        userAgent: "curl/8.0",
      },
    });
  });

  test("ordinary entries leave the actor and labels out", async () => {
    await wrapCall(() => okAsync(1))(signedIn);
    expect(writes[0].actor).toBeUndefined();
    expect(writes[0]["logging.googleapis.com/labels"]).toBeUndefined();
  });

  test("setActor identifies the caller of an onRequest handler", async () => {
    const res = {
      headersSent: false,
      status() {
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    const req = { method: "GET", path: "/admin", ip: "203.0.113.9", headers: { "user-agent": "bot" } } as unknown as Request;
    await wrapRequest(() => {
      logContext.setActor({ uid: "u7" });
      throw new HttpsError("unauthenticated", "no token");
    })(req, res);
    expect(writes[0]).toMatchObject({
      securityEvent: "authz_fail",
      actor: { uid: "u7", ip: "203.0.113.9", userAgent: "bot" },
    });
  });

  test("audit writes immediately and the final entry records the outcome", async () => {
    await wrapCall(() => {
      logContext.audit("authz_change", { target: "users/u9", role: "admin" });
      return errAsync(new DbError("write failed"));
    })(signedIn).catch(() => {});
    expect(writes[0]).toMatchObject({
      severity: "NOTICE",
      message: "authz_change",
      auditEvent: "authz_change",
      target: "users/u9",
      actor: { uid: "u1", ip: "203.0.113.5" },
      "logging.googleapis.com/labels": { audit: "true" },
    });
    expect(writes[1]).toMatchObject({
      severity: "ERROR",
      auditEvents: ["authz_change"],
      actor: { uid: "u1" },
      "logging.googleapis.com/labels": { audit: "true" },
    });
  });
});

describe("toExternalError", () => {
  const httpError = (status: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

  test("timeouts are retryable deadline-exceeded", () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    expect(toExternalError("partner", timeout)).toMatchObject({
      code: "deadline-exceeded",
      severity: "ERROR",
      retryable: true,
      provider: "partner",
    });
  });

  test("network failures are retryable unavailable", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(toExternalError("partner", new TypeError("fetch failed", { cause }))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  test("429 is a retryable WARNING that keeps Retry-After and the request id", () => {
    const e = toExternalError("openai", httpError(429, { headers: new Headers({ "retry-after": "7", "x-request-id": "req_1" }) }));
    expect(e).toMatchObject({ code: "resource-exhausted", severity: "WARNING", retryable: true });
    expect(e.upstream).toMatchObject({ status: 429, retryAfterMs: 7000, requestId: "req_1" });
  });

  test("5xx, including Anthropic's 529 overloaded, is retryable unavailable", () => {
    const e = toExternalError("anthropic", httpError(529, { requestID: "req_a" }));
    expect(e).toMatchObject({ code: "unavailable", severity: "ERROR", retryable: true });
    expect(e.upstream.requestId).toBe("req_a");
  });

  test("other 4xx means our request or credentials are wrong: internal, not retried", () => {
    expect(toExternalError("stripe", httpError(401))).toMatchObject({ code: "internal", severity: "ERROR", retryable: false });
    expect(toExternalError("stripe", httpError(400))).toMatchObject({ code: "internal", retryable: false });
  });

  test("axios-style errors are read from error.response", () => {
    const axiosError = Object.assign(new Error("Request failed"), {
      code: "ERR_BAD_RESPONSE",
      response: { status: 503, headers: { "x-request-id": "ax_1" } },
    });
    const e = toExternalError("partner", axiosError);
    expect(e).toMatchObject({ code: "unavailable", retryable: true });
    expect(e.upstream).toMatchObject({ status: 503, code: "ERR_BAD_RESPONSE", requestId: "ax_1" });
  });

  test("gRPC status codes from Google Cloud clients map to the same codes", () => {
    const grpc = (code: number) => Object.assign(new Error(`${code} grpc`), { code });
    expect(toExternalError("firestore", grpc(14))).toMatchObject({ code: "unavailable", retryable: true });
    expect(toExternalError("firestore", grpc(10))).toMatchObject({ code: "aborted", severity: "WARNING", retryable: true });
    expect(toExternalError("firestore", grpc(6))).toMatchObject({ code: "already-exists", severity: "WARNING", retryable: false });
    expect(toExternalError("firestore", grpc(7))).toMatchObject({ code: "internal", retryable: false });
  });

  test("DOMException legacy codes are not mistaken for gRPC codes", () => {
    const e = toExternalError("partner", new DOMException("The operation timed out", "TimeoutError"));
    expect(e).toMatchObject({ code: "deadline-exceeded", retryable: true });
    expect(e.upstream.code).toBeUndefined();
  });

  test("the stack starts at the caller, not inside toExternalError", () => {
    expect(toExternalError("partner", new Error("x")).stack).not.toContain("toExternalError");
  });

  test("a non-ok fetch Response converts directly", () => {
    const e = toExternalError("partner", new Response("nope", { status: 404, headers: { "x-request-id": "r9" } }));
    expect(e).toMatchObject({ code: "internal", message: "partner: HTTP 404" });
    expect(e.upstream).toMatchObject({ status: 404, requestId: "r9" });
  });

  test("classify overrides the defaults for provider-specific errors", () => {
    const declined = Object.assign(new Error("Your card was declined."), {
      type: "StripeCardError",
      code: "card_declined",
      statusCode: 402,
      requestId: "req_s",
      decline_code: "insufficient_funds",
    });
    const e = toExternalError("stripe", declined, (error, upstream) =>
      upstream.type === "StripeCardError"
        ? {
            code: "failed-precondition",
            publicMessage: "カードが拒否されました。",
            context: { declineCode: (error as { decline_code?: string }).decline_code },
          }
        : undefined,
    );
    expect(e).toMatchObject({
      code: "failed-precondition",
      severity: "WARNING",
      retryable: false,
      publicMessage: "カードが拒否されました。",
    });
    expect(e.context).toMatchObject({
      declineCode: "insufficient_funds",
      provider: "stripe",
      upstream: { code: "card_declined", requestId: "req_s", status: 402 },
    });
  });

  test("the log entry carries the upstream summary", async () => {
    await wrapCall(() => errAsync(toExternalError("openai", httpError(503, { request_id: "req_o" }))))(callRequest()).catch(
      () => {},
    );
    expect(writes[0]).toMatchObject({
      errorName: "ExternalError",
      provider: "openai",
      upstream: { status: 503, requestId: "req_o" },
      retryable: true,
    });
  });
});

describe("retry", () => {
  const unavailable = () => toExternalError("partner", Object.assign(new Error("HTTP 503"), { status: 503 }));
  /** Fails `failures` times with a retryable error, then succeeds. Counts calls. */
  const flaky = (failures: number) => {
    const state = { calls: 0 };
    const fn = () => (++state.calls <= failures ? errAsync(unavailable()) : okAsync(`ok after ${state.calls}`));
    return { fn, state };
  };
  /** Pretends the wrapped call issued an HTTP request, as fetch does through diagnostics_channel. */
  const sendRequest = () =>
    dc.channel("undici:request:create").publish({ request: { method: "POST", origin: "https://api.example.com", path: "/v1/x" } });
  const inProduction = async (body: () => Promise<void>) => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await body();
    } finally {
      process.env.NODE_ENV = previous;
    }
  };

  test("retries retryable errors and records the attempts in the wide event", async () => {
    const { fn, state } = flaky(2);
    const value = await wrapCall(() => retry(fn, { baseDelayMs: 1 }))(callRequest());
    expect(value).toBe("ok after 3");
    expect(state.calls).toBe(3);
    expect(writes[0].retries).toEqual([expect.objectContaining({ attempts: 3, outcome: "ok" })]);
  });

  test("does not retry errors that are not retryable", async () => {
    const state = { calls: 0 };
    const result = await retry(() => {
      state.calls++;
      return errAsync(new UserNotFound("x"));
    });
    expect(result.isErr()).toBe(true);
    expect(state.calls).toBe(1);
  });

  test("gives up after `attempts`", async () => {
    const { fn, state } = flaky(10);
    await wrapCall(() => retry(fn, { attempts: 2, baseDelayMs: 1 }))(callRequest()).catch(() => {});
    expect(state.calls).toBe(2);
    expect(writes[0].retries).toEqual([expect.objectContaining({ attempts: 2, stoppedBy: "attempts" })]);
  });

  test("waits for Retry-After, but stops when it is longer than maxDelayMs", async () => {
    const throttled = (ms: number) => () =>
      errAsync(toExternalError("partner", Object.assign(new Error("429"), { status: 429, headers: { "retry-after": String(ms / 1000) } })));
    const state = { calls: 0 };
    await retry(() => {
      state.calls++;
      return throttled(5000)();
    }, { maxDelayMs: 2000 });
    expect(state.calls).toBe(1);
    const short = { calls: 0 };
    await retry(() => {
      short.calls++;
      return short.calls === 1 ? throttled(1)() : okAsync(1);
    });
    expect(short.calls).toBe(2);
  });

  test("stops when the next wait would exceed the time budget", async () => {
    const { fn, state } = flaky(5);
    await wrapCall(() => retry(fn, { budgetMs: 0 }))(callRequest()).catch(() => {});
    expect(state.calls).toBe(1);
    expect(writes[0].retries).toEqual([expect.objectContaining({ stoppedBy: "budget" })]);
  });

  test("a call that already retried internally is not retried again, and the evidence is logged", async () => {
    await inProduction(async () => {
      const state = { calls: 0 };
      await wrapCall(() =>
        retry(() => {
          state.calls++;
          sendRequest();
          sendRequest(); // the same request twice in one attempt: the callee retried by itself
          return errAsync(unavailable());
        }),
      )(callRequest()).catch(() => {});
      expect(state.calls).toBe(1);
      expect(writes[0].retries).toEqual([
        expect.objectContaining({
          stoppedBy: "internal-retry",
          repeatedRequest: { request: "POST https://api.example.com/v1/x", count: 2 },
        }),
      ]);
    });
  });

  test("in tests and the emulator, wrapping a self-retrying call fails loudly", async () => {
    const attempt = retry(() => {
      sendRequest();
      sendRequest();
      return okAsync(1);
    });
    await expect(Promise.resolve(attempt)).rejects.toThrow("already retried internally");
  });

  test("a single request per attempt, or an allowed repeat, is not an internal retry", async () => {
    const { fn, state } = flaky(1);
    const once = await retry(
      () => {
        sendRequest();
        return fn();
      },
      { baseDelayMs: 1 },
    );
    expect(once.isOk()).toBe(true);
    expect(state.calls).toBe(2);
    const polling = await retry(
      () => {
        sendRequest();
        sendRequest();
        return okAsync(1);
      },
      { allowRepeatedRequests: true },
    );
    expect(polling.isOk()).toBe(true);
  });

  test("nested retry() calls count as an internal retry of the outer one", async () => {
    await inProduction(async () => {
      const { fn, state } = flaky(10);
      await wrapCall(() => retry(() => retry(fn, { attempts: 2, baseDelayMs: 1 }), { baseDelayMs: 1 }))(callRequest()).catch(
        () => {},
      );
      expect(state.calls).toBe(2); // the inner retry only: the outer one did not multiply it
      expect(writes[0].retries).toContainEqual(expect.objectContaining({ stoppedBy: "internal-retry" }));
    });
  });

  // Compile-time checks only: never run.
  const typeChecks = () => {
    const stripeCall = () => errAsync(toExternalError("stripe", new Error("x")));
    // @ts-expect-error stripe's SDK already retries this call
    retry(stripeCall);
    retry(stripeCall, { sdkRetriesDisabled: true });
    // @ts-expect-error detected through andThen as well
    retry(() => okAsync(1).andThen(() => stripeCall()));
    retry(() => errAsync(toExternalError("partner", new Error("x"))));
  };
  void typeChecks;
});

describe("timeout guard", () => {
  const unavailable = () => toExternalError("partner", Object.assign(new Error("HTTP 503"), { status: 503 }));

  test("a handler about to time out is cut off, and its entry is still written", async () => {
    configure({ timeoutSeconds: 0.06, timeoutMarginMs: 20 }); // the guard fires after 40 ms
    const started = performance.now();
    const call = wrapCall(async () => {
      logContext.set({ step: "calling the model" });
      logContext.debug("prompt sent");
      await sleep(400);
      return ok("too late");
    });
    await expect(call(callRequest())).rejects.toMatchObject({ code: "deadline-exceeded", message: "DEADLINE_EXCEEDED" });
    expect(performance.now() - started).toBeLessThan(300);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      severity: "ERROR",
      errorName: "DeadlineExceeded",
      step: "calling the model",
      breadcrumbs: [expect.objectContaining({ message: "prompt sent" })],
    });
    await sleep(450);
    expect(writes).toHaveLength(1); // the late finish writes nothing more
  });

  test("logContext.signal aborts when the guard fires, so external calls can stop", async () => {
    configure({ timeoutSeconds: 0.06, timeoutMarginMs: 20 });
    let reason: unknown;
    await wrapCall(async () => {
      const signal = logContext.signal as AbortSignal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => {
          reason = signal.reason;
          resolve();
        }),
      );
      return ok(1);
    })(callRequest()).catch(() => {});
    expect(reason).toMatchObject({ name: "DeadlineExceeded", code: "deadline-exceeded" });
  });

  test("without a timeout nothing is guarded and the signal never aborts", async () => {
    let signal: AbortSignal | undefined;
    const value = await wrapCall(async () => {
      signal = logContext.signal;
      await sleep(30);
      return ok("done");
    })(callRequest());
    expect(value).toBe("done");
    expect(signal?.aborted).toBe(false);
    expect(logContext.signal).toBeUndefined();
  });

  test("a per-handler timeout overrides the global one", async () => {
    configure({ timeoutSeconds: 60 });
    const call = wrapCall(
      async () => {
        await sleep(400);
        return ok(1);
      },
      { timeoutSeconds: 0.06, timeoutMarginMs: 20 },
    );
    await expect(call(callRequest())).rejects.toMatchObject({ code: "deadline-exceeded" });
  });

  test("wrapRequest answers 504 and wrapEvent rethrows so the platform retries", async () => {
    configure({ timeoutSeconds: 0.06, timeoutMarginMs: 20 });
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      headersSent: false,
      status(code: number) {
        sent.status = code;
        return res;
      },
      json(body: unknown) {
        sent.body = body;
        return res;
      },
    } as unknown as Response;
    await wrapRequest(async () => {
      await sleep(300);
      return ok(1);
    })({ method: "GET", path: "/slow" } as Request, res);
    expect(sent).toMatchObject({ status: 504, body: { error: { status: "DEADLINE_EXCEEDED" } } });
    const slowEvent = wrapEvent(async () => {
      await sleep(300);
      return ok(1);
    });
    await expect(slowEvent({ id: "e1", type: "t" })).rejects.toMatchObject({ name: "DeadlineExceeded" });
  });

  test("retry() gives up when its next wait would pass the deadline", async () => {
    configure({ timeoutSeconds: 0.06, timeoutMarginMs: 20 });
    const random = spyOn(Math, "random").mockReturnValue(0.99);
    const state = { calls: 0 };
    try {
      await wrapCall(() =>
        retry(
          () => {
            state.calls++;
            return errAsync(unavailable());
          },
          { baseDelayMs: 10_000, maxDelayMs: 10_000, budgetMs: 60_000 },
        ),
      )(callRequest()).catch(() => {});
    } finally {
      random.mockRestore();
    }
    expect(state.calls).toBe(1);
    expect(writes[0].retries).toEqual([expect.objectContaining({ stoppedBy: "timeout" })]);
  });

  test("retry() does not call fn once the deadline has passed", async () => {
    configure({ timeoutSeconds: 0.06, timeoutMarginMs: 20 });
    const slow = { calls: 0 };
    const late = { calls: 0 };
    await wrapCall(() =>
      retry(async () => {
        slow.calls++;
        await sleep(120); // outlives the guard, then fails with a retryable error
        return err(unavailable());
      }),
    )(callRequest()).catch(() => {});
    await wrapCall(async () => {
      await sleep(100);
      return retry(() => {
        late.calls++;
        return okAsync(1);
      });
    })(callRequest()).catch(() => {});
    await sleep(200);
    expect(slow.calls).toBe(1);
    expect(late.calls).toBe(0);
  });
});

describe("idempotent events", () => {
  const memoryStore = () => {
    const store = {
      entries: new Map<string, "processing" | "done">(),
      claims: 0,
      async claim(key: string) {
        store.claims++;
        const state = store.entries.get(key);
        if (state === "done") return "done" as const;
        if (state === "processing") return "in-flight" as const;
        store.entries.set(key, "processing");
        return "claimed" as const;
      },
      async complete(key: string) {
        store.entries.set(key, "done");
      },
      async release(key: string) {
        store.entries.delete(key);
      },
    };
    return store;
  };
  const delivery = (id?: string, time?: string) => ({ id, type: "t", time });

  test("a redelivered event is skipped once it has been processed", async () => {
    const store = memoryStore();
    const state = { runs: 0 };
    const handler = wrapEvent(
      () => {
        state.runs++;
        return okAsync(undefined);
      },
      { idempotency: store },
    );
    await handler(delivery("e1"));
    await handler(delivery("e1"));
    expect(state.runs).toBe(1);
    expect(writes[0].duplicate).toBeUndefined();
    expect(writes[1]).toMatchObject({ severity: "INFO", eventId: "e1", duplicate: true });
  });

  test("a retryable failure releases the claim, so the retry runs again", async () => {
    const store = memoryStore();
    const state = { runs: 0 };
    const handler = wrapEvent(() => (++state.runs === 1 ? errAsync(new DbError("db down")) : okAsync(undefined)), {
      idempotency: store,
    });
    await expect(handler(delivery("e1"))).rejects.toMatchObject({ name: "DbError" });
    expect(store.entries.size).toBe(0);
    await handler(delivery("e1"));
    expect(state.runs).toBe(2);
    expect([...store.entries.values()]).toEqual(["done"]);
  });

  test("a failure that is acknowledged counts as processed", async () => {
    const store = memoryStore();
    const state = { runs: 0 };
    const handler = wrapEvent(
      () => {
        state.runs++;
        return errAsync(new UserNotFound("bad payload"));
      },
      { idempotency: store },
    );
    await handler(delivery("e1"));
    await handler(delivery("e1"));
    expect(state.runs).toBe(1);
  });

  test("a throw releases the claim too", async () => {
    const store = memoryStore();
    const handler = wrapEvent(
      () => {
        throw new Error("boom");
      },
      { idempotency: store },
    );
    await expect(handler(delivery("e1"))).rejects.toMatchObject({ code: "internal" });
    expect(store.entries.size).toBe(0);
  });

  test("an event another instance is processing is retried later, not skipped", async () => {
    const store = memoryStore();
    store.entries.set("fn:e1", "processing");
    const state = { runs: 0 };
    const handler = wrapEvent(
      () => {
        state.runs++;
        return okAsync(undefined);
      },
      { idempotency: store },
    );
    await expect(handler(delivery("e1"))).rejects.toMatchObject({ name: "EventInFlight", retryable: true });
    expect(state.runs).toBe(0);
    expect(writes[0]).toMatchObject({ severity: "WARNING", errorName: "EventInFlight" });
  });

  test("the claim key includes the function name", async () => {
    const store = memoryStore();
    const previous = process.env.K_SERVICE;
    process.env.K_SERVICE = "on-order";
    try {
      await wrapEvent(() => okAsync(undefined), { idempotency: store })(delivery("a/b"));
    } finally {
      if (previous === undefined) delete process.env.K_SERVICE;
      else process.env.K_SERVICE = previous;
    }
    expect([...store.entries.keys()]).toEqual(["on-order:a_b"]);
  });

  test("events without an id, and events that are too old, never touch the store", async () => {
    const store = memoryStore();
    const state = { runs: 0 };
    const handler = wrapEvent(
      () => {
        state.runs++;
        return okAsync(undefined);
      },
      { idempotency: store, maxEventAgeMs: 60_000 },
    );
    await handler(delivery(undefined));
    await handler(delivery("old", new Date(Date.now() - 120_000).toISOString()));
    expect(state.runs).toBe(1);
    expect(store.claims).toBe(0);
  });

  describe("firestoreIdempotency", () => {
    const fakeFirestore = () => {
      const docs = new Map<string, Record<string, any>>();
      const ref = (path: string) => ({
        path,
        set: async (data: Record<string, any>) => void docs.set(path, data),
        delete: async () => void docs.delete(path),
      });
      const db = {
        collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
        runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            get: async (r: { path: string }) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
            set: (r: { path: string }, data: Record<string, any>) => void docs.set(r.path, data),
          }),
      };
      return { db: db as never, docs };
    };

    test("claim, done, release and lease expiry", async () => {
      const { db, docs } = fakeFirestore();
      const store = firestoreIdempotency(db, { ttlMs: 86_400_000 });
      expect(await store.claim("k1", 1000)).toBe("claimed");
      const doc = docs.get("_resultlog_events/k1");
      expect(doc).toMatchObject({ state: "processing" });
      expect(doc?.expireAt).toBeInstanceOf(Date);
      expect(doc?.expireAt.getTime()).toBeGreaterThan(Date.now() + 80_000_000);
      expect(await store.claim("k1", 1000)).toBe("in-flight");
      await store.complete("k1");
      expect(await store.claim("k1", 1000)).toBe("done");
      await store.release("k1");
      expect(await store.claim("k1", 5)).toBe("claimed");
      await sleep(20);
      expect(await store.claim("k1", 1000)).toBe("claimed"); // the lease ran out: the first instance is presumed dead
    });

    test("the collection name is configurable", async () => {
      const { db, docs } = fakeFirestore();
      await firestoreIdempotency(db, { collection: "processed" }).claim("k1", 1000);
      expect([...docs.keys()]).toEqual(["processed/k1"]);
    });
  });
});

describe("secret patterns", () => {
  const logValue = async (value: unknown) => {
    await wrapCall(() => {
      logContext.set({ value });
      return okAsync(1);
    })(callRequest());
    return writes.at(-1)?.value;
  };

  test.each([
    ["a JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlMTIzNDU2 end", "token [REDACTED:jwt] end"],
    ["a bearer token", "sent Authorization: Bearer abcdef1234567890 now", "sent Authorization: Bearer [REDACTED] now"],
    ["a Stripe key", `key sk_live_${"a".repeat(24)} used`, "key [REDACTED:key] used"],
    ["an OpenAI key", `sk-proj-${"a".repeat(30)}`, "[REDACTED:key]"],
    ["an Anthropic key", `sk-ant-api03-${"a".repeat(30)}`, "[REDACTED:key]"],
    ["a Google API key", `AIza${"A".repeat(35)}`, "[REDACTED:key]"],
    ["an AWS access key id", `AKIA${"A".repeat(16)}`, "[REDACTED:key]"],
    ["a GitHub token", `ghp_${"a".repeat(36)}`, "[REDACTED:key]"],
    [
      "a private key block",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
      "[REDACTED:private-key]",
    ],
    [
      "a secret in a URL query",
      "GET https://api.example.com/v1?api_key=abc123&page=2",
      "GET https://api.example.com/v1?api_key=[REDACTED]&page=2",
    ],
    ["a card number", "card 4242 4242 4242 4242 declined", "card [REDACTED:card] declined"],
    ["a card number with hyphens", "4242-4242-4242-4242", "[REDACTED:card]"],
  ])("redacts %s", async (_name, input, expected) => {
    expect(await logValue(input)).toBe(expected);
  });

  test.each([
    ["a number that fails the Luhn check", "4242 4242 4242 4241"],
    ["a millisecond timestamp", "1700000000000"],
    ["a short number", "order 4111"],
    ["an ordinary id", "id 5f8d0d55b54764421b7156c3 ok"],
  ])("leaves %s alone", async (_name, input) => {
    expect(await logValue(input)).toBe(input);
  });

  test("secrets inside error messages and stacks are redacted too", async () => {
    await wrapCall(() => errAsync(new DbError(`auth failed for sk_live_${"a".repeat(24)}`)))(callRequest()).catch(() => {});
    expect(writes[0].message).toContain("auth failed for [REDACTED:key]");
    expect(JSON.stringify(writes[0])).not.toContain("sk_live_");
  });

  test("extra patterns can be configured", async () => {
    configure({ secretPatterns: [/internal-\d{6}/] });
    expect(await logValue("ticket internal-123456")).toBe("ticket [REDACTED:custom]");
  });
});

describe("outgoing calls", () => {
  test("calls are summarized per host, with status, errors and calls still pending", async () => {
    const call = (origin: string) => ({ method: "POST", origin, path: "/v1/chat/completions?stream=1" });
    await wrapCall(async () => {
      const ok200 = call("https://api.openai.com");
      publish("undici:request:create", { request: ok200 });
      await sleep(15);
      publish("undici:request:headers", { request: ok200, response: { statusCode: 200 } });
      const broken = call("https://api.openai.com");
      publish("undici:request:create", { request: broken });
      publish("undici:request:error", { request: broken, error: Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
      publish("undici:request:create", { request: call("https://api.openai.com") }); // never answered
      return ok(1);
    })(callRequest());
    expect(writes[0].external).toEqual({
      "api.openai.com": {
        calls: 3,
        statuses: { "200": 1 },
        errors: 1,
        pending: 1,
        totalMs: expect.any(Number),
        maxMs: expect.any(Number),
      },
    });
    expect(writes[0].external["api.openai.com"].maxMs).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(writes[0])).not.toContain("stream=1"); // the query string is never logged
  });

  test("requests made with the http module (axios, Stripe) are summarized too", async () => {
    await wrapCall(() => {
      const request = { method: "GET", protocol: "https:", host: "api.stripe.com", path: "/v1/customers" };
      publish("http.client.request.start", { request });
      publish("http.client.response.finish", { request, response: { statusCode: 503 } });
      publish("http.client.request.error", { request, error: new Error("late")}); // a second outcome is ignored
      return okAsync(1);
    })(callRequest());
    expect(writes[0].external["api.stripe.com"]).toMatchObject({ calls: 1, statuses: { "503": 1 } });
    expect(writes[0].external["api.stripe.com"].errors).toBeUndefined();
  });

  test("the metadata server is not worth recording", async () => {
    await wrapCall(() => {
      const request = { method: "GET", protocol: "http:", host: "metadata.google.internal", path: "/token" };
      publish("http.client.request.start", { request });
      publish("http.client.response.finish", { request, response: { statusCode: 200 } });
      return okAsync(1);
    })(callRequest());
    expect(writes[0].external).toBeUndefined();
  });

  test("recording can be switched off, and requests outside an invocation are ignored", async () => {
    configure({ recordExternalCalls: false });
    await wrapCall(() => {
      publish("undici:request:create", { request: { method: "GET", origin: "https://api.example.com", path: "/" } });
      return okAsync(1);
    })(callRequest());
    expect(writes[0].external).toBeUndefined();
    configure({ recordExternalCalls: true });
    expect(() =>
      publish("undici:request:create", { request: { method: "GET", origin: "https://api.example.com", path: "/" } }),
    ).not.toThrow();
  });

  test("a failed invocation reports its calls as well", async () => {
    await wrapCall(() => {
      const request = { method: "POST", origin: "https://api.anthropic.com", path: "/v1/messages" };
      publish("undici:request:create", { request });
      publish("undici:request:headers", { request, response: { statusCode: 529 } });
      return errAsync(new DbError("overloaded"));
    })(callRequest()).catch(() => {});
    expect(writes[0].external["api.anthropic.com"]).toMatchObject({ calls: 1, statuses: { "529": 1 } });
  });
});

describe("cold start", () => {
  test("only the first invocation of an instance is marked", async () => {
    setColdStart(true); // as a fresh Cloud Run instance would have
    const run = () => wrapCall(() => okAsync(1))(callRequest());
    await run();
    await run();
    expect(writes[0].coldStart).toBe(true);
    expect(writes[1].coldStart).toBeUndefined();
  });

  test("cold start entries survive sampling", async () => {
    setColdStart(true);
    configure({ successSampleRate: 0 });
    await wrapCall(() => okAsync(1))(callRequest());
    await wrapCall(() => okAsync(1))(callRequest());
    expect(writes).toHaveLength(1);
    expect(writes[0].coldStart).toBe(true);
  });
});

describe("LLM calls", () => {
  // Real response shapes of several providers. resultlog has no table of providers: it reads what looks like a
  // token count, a model and a finish reason, wherever they are.
  const shapes: Record<string, { response: unknown; expected: Record<string, unknown> }> = {
    "OpenAI chat completions": {
      response: {
        model: "gpt-4o",
        choices: [{ finish_reason: "stop", message: { content: "hi" } }],
        usage: {
          prompt_tokens: 19,
          completion_tokens: 10,
          total_tokens: 29,
          prompt_tokens_details: { cached_tokens: 4, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 3, accepted_prediction_tokens: 0 },
        },
      },
      expected: {
        calls: 1,
        inputTokens: 19,
        outputTokens: 10,
        totalTokens: 29,
        cachedTokens: 4,
        reasoningTokens: 3,
        models: { "gpt-4o": { calls: 1, inputTokens: 19, outputTokens: 10 } },
        finishReasons: { stop: 1 },
      },
    },
    "OpenAI responses API": {
      response: {
        model: "gpt-5",
        status: "completed",
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 50 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 8 },
          total_tokens: 120,
        },
      },
      expected: {
        calls: 1,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedTokens: 50,
        reasoningTokens: 8,
        models: { "gpt-5": { calls: 1, inputTokens: 100, outputTokens: 20 } },
      },
    },
    "Anthropic messages": {
      response: {
        model: "claude-x",
        stop_reason: "max_tokens",
        usage: {
          input_tokens: 12,
          output_tokens: 300,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
          cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 },
        },
      },
      expected: {
        calls: 1,
        inputTokens: 12,
        outputTokens: 300,
        cachedTokens: 7,
        cacheWriteTokens: 5,
        truncated: 1,
        finishReasons: { max_tokens: 1 },
        models: { "claude-x": { calls: 1, inputTokens: 12, outputTokens: 300 } },
      },
    },
    "Gemini generateContent": {
      response: {
        candidates: [{ finishReason: "STOP", content: { parts: [] } }],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 21,
          totalTokenCount: 29,
          thoughtsTokenCount: 6,
          cachedContentTokenCount: 2,
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 8 }],
        },
        modelVersion: "gemini-x",
      },
      expected: {
        calls: 1,
        inputTokens: 8,
        outputTokens: 21,
        totalTokens: 29,
        reasoningTokens: 6,
        cachedTokens: 2,
        finishReasons: { STOP: 1 },
        models: { "gemini-x": { calls: 1, inputTokens: 8, outputTokens: 21 } },
      },
    },
    "Vercel AI SDK": {
      response: {
        text: "hi",
        finishReason: "stop",
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, reasoningTokens: 2, cachedInputTokens: 3 },
        response: { modelId: "m-1" },
      },
      expected: {
        calls: 1,
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        reasoningTokens: 2,
        cachedTokens: 3,
        finishReasons: { stop: 1 },
        models: { "m-1": { calls: 1, inputTokens: 11, outputTokens: 7 } },
      },
    },
    "Bedrock converse": {
      response: {
        stopReason: "end_turn",
        usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, cacheReadInputTokens: 1 },
      },
      expected: { calls: 1, inputTokens: 9, outputTokens: 4, totalTokens: 13, cachedTokens: 1, finishReasons: { end_turn: 1 } },
    },
    "Cohere (usage nested in billed_units)": {
      response: {
        usage: {
          billed_units: { input_tokens: 5, output_tokens: 6 },
          tokens: { input_tokens: 5, output_tokens: 6 },
        },
      },
      expected: { calls: 1, inputTokens: 5, outputTokens: 6 },
    },
  };

  const record = async (...responses: unknown[]) => {
    await wrapCall(() => {
      for (const response of responses) logContext.llm(response);
      return okAsync(1);
    })(callRequest());
    return writes[0].llm;
  };

  test.each(Object.entries(shapes))("reads tokens, model and finish reason from %s", async (_name, { response, expected }) => {
    expect(await record(response)).toMatchObject(expected);
  });

  test("fields that are zero or unknown are left out", async () => {
    const llm = await record(shapes["Gemini generateContent"]?.response);
    expect(llm).not.toHaveProperty("cacheWriteTokens");
    expect(llm).not.toHaveProperty("truncated");
    expect(llm).not.toHaveProperty("cost");
  });

  test("calls add up, per model as well", async () => {
    const llm = await record(shapes["OpenAI chat completions"]?.response, shapes["OpenAI chat completions"]?.response, shapes["Anthropic messages"]?.response);
    expect(llm).toMatchObject({
      calls: 3,
      inputTokens: 19 + 19 + 12,
      outputTokens: 10 + 10 + 300,
      finishReasons: { stop: 2, max_tokens: 1 },
      models: { "gpt-4o": { calls: 2, inputTokens: 38, outputTokens: 20 }, "claude-x": { calls: 1 } },
    });
  });

  test("a response in a shape it doesn't know is counted as unrecognized", async () => {
    expect(await record({ choices: [] })).toMatchObject({ calls: 1, unrecognized: 1 });
  });

  test("numbers you pass win over what was read", async () => {
    await wrapCall(() => {
      logContext.llm({ model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 2 } }, { model: "my-alias", inputTokens: 40 });
      return okAsync(1);
    })(callRequest());
    expect(writes[0].llm).toMatchObject({ inputTokens: 40, outputTokens: 2, models: { "my-alias": { calls: 1, inputTokens: 40 } } });
  });

  test("it returns what it was given, and does nothing outside a wrapped handler", () => {
    const response = { usage: { input_tokens: 1 } };
    expect(logContext.llm(response)).toBe(response);
    expect(writes).toHaveLength(0);
  });

  test("a cut-off or blocked generation is flagged and never sampled away", async () => {
    configure({ successSampleRate: 0 });
    await wrapCall(() => {
      logContext.llm({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      return okAsync(1);
    })(callRequest());
    expect(writes).toHaveLength(0);
    await record({ finish_reason: "length", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(writes).toHaveLength(1);
    expect(writes[0].llm).toMatchObject({ truncated: 1 });
    writes.length = 0;
    for (const reason of ["content_filter", "SAFETY", "refusal"]) {
      await record({ finishReason: reason, usage: { inputTokens: 1, outputTokens: 1 } });
      expect(writes.pop()?.llm).toMatchObject({ blocked: 1 });
    }
  });

  test("cost comes from your own function; nothing is built in", async () => {
    configure({
      price: ({ model, inputTokens = 0, outputTokens = 0 }) => (model === "m-1" ? inputTokens * 0.001 + outputTokens * 0.002 : undefined),
    });
    const llm = await record(shapes["Vercel AI SDK"]?.response, shapes["Bedrock converse"]?.response);
    expect(llm.cost).toBeCloseTo(11 * 0.001 + 7 * 0.002, 9); // only the call the function priced
  });

  test("a price function that throws never breaks logging", async () => {
    configure({
      price: () => {
        throw new Error("bad table");
      },
    });
    expect(await record(shapes["Bedrock converse"]?.response)).toMatchObject({ calls: 1, inputTokens: 9 });
  });

  describe("streams", () => {
    const anthropicStream = async function* () {
      await sleep(20);
      yield { type: "message_start", message: { model: "claude-x", usage: { input_tokens: 25, output_tokens: 1 } } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } };
    };

    test("chunks pass through; usage across chunks, the model and the time to first chunk are recorded", async () => {
      const seen: unknown[] = [];
      await wrapCall(async () => {
        for await (const chunk of logContext.llm(anthropicStream())) seen.push(chunk);
        return ok(1);
      })(callRequest());
      expect(seen).toHaveLength(3);
      expect(writes[0].llm).toMatchObject({
        calls: 1,
        inputTokens: 25,
        outputTokens: 15, // the largest figure seen: the provider reports running totals
        finishReasons: { end_turn: 1 },
        models: { "claude-x": { calls: 1, inputTokens: 25, outputTokens: 15 } },
      });
      expect(writes[0].llm.ttftMs).toBeGreaterThanOrEqual(15);
      expect(writes[0].llm.interrupted).toBeUndefined();
    });

    test("a stream that fails midway is recorded as interrupted, and the error still reaches the caller", async () => {
      const failing = async function* () {
        yield { model: "m", usage: { prompt_tokens: 7 } };
        throw new Error("overloaded");
      };
      await expect(
        wrapCall(async () => {
          for await (const _chunk of logContext.llm(failing())) {
            // consume
          }
          return ok(1);
        })(callRequest()),
      ).rejects.toMatchObject({ code: "internal" });
      expect(writes[0].llm).toMatchObject({ calls: 1, inputTokens: 7, interrupted: 1 });
    });

    test("a consumer that stops early counts as interrupted", async () => {
      await wrapCall(async () => {
        for await (const _chunk of logContext.llm(anthropicStream())) break;
        return ok(1);
      })(callRequest());
      expect(writes[0].llm).toMatchObject({ calls: 1, interrupted: 1 });
    });
  });
});

describe("fallback", () => {
  const down = (provider: string) => () =>
    errAsync(toExternalError(provider, Object.assign(new Error("HTTP 503"), { status: 503 })));

  test("moves on when the provider is at fault, and records the attempt it left", async () => {
    const calls: string[] = [];
    const value = await wrapCall(() =>
      fallback(
        () => {
          calls.push("a");
          return down("a")();
        },
        () => {
          calls.push("b");
          return okAsync("from b");
        },
      ),
    )(callRequest());
    expect(value).toBe("from b");
    expect(calls).toEqual(["a", "b"]);
    expect(writes[0]).toMatchObject({
      severity: "INFO",
      handledErrors: [{ fallback: 0, error: { name: "ExternalError", provider: "a" } }],
    });
  });

  test("stays put when the request is at fault, since another provider would refuse it as well", async () => {
    const calls: string[] = [];
    await wrapCall(() =>
      fallback(
        () => {
          calls.push("a");
          return errAsync(new UserNotFound("bad input"));
        },
        () => {
          calls.push("b");
          return okAsync(1);
        },
      ),
    )(callRequest()).catch(() => {});
    expect(calls).toEqual(["a"]);
  });

  test("when every attempt fails, the last error is the result", async () => {
    await wrapCall(() => fallback(down("a"), down("b"), down("c")))(callRequest()).catch(() => {});
    expect(writes[0]).toMatchObject({ severity: "ERROR", provider: "c" });
    expect(writes[0].handledErrors).toHaveLength(2);
  });

  test("it does not start another attempt once the deadline has passed", async () => {
    configure({ timeoutSeconds: 0.06, timeoutMarginMs: 20 });
    const calls: string[] = [];
    await wrapCall(() =>
      fallback(
        async () => {
          calls.push("a");
          await sleep(100);
          return await down("a")();
        },
        () => {
          calls.push("b");
          return okAsync(1);
        },
      ),
    )(callRequest()).catch(() => {});
    await sleep(150);
    expect(calls).toEqual(["a"]);
  });

  // Compile-time check only: attempts against different providers fail with different error types.
  const typeChecks = () => {
    const viaA = () => errAsync(toExternalError("anthropic", new Error("x")));
    const viaB = () => okAsync("text");
    fallback(viaA, viaB);
    fallback(viaA, () => errAsync(toExternalError("openai", new Error("y"))), viaB);
  };
  void typeChecks;
});

describe("sink and test helpers", () => {
  test("configure({ sink }) receives every entry instead of the platform logger", async () => {
    const received: Record<string, unknown>[] = [];
    configure({ sink: (entry) => void received.push(entry) });
    await wrapCall(() => okAsync(1))(callRequest());
    logContext.audit("sensitive_read");
    expect(received.map((entry) => entry.severity)).toEqual(["INFO", "NOTICE"]);
    expect(writes).toHaveLength(0);
  });

  test("a sink that throws never breaks the invocation", async () => {
    configure({
      sink: () => {
        throw new Error("disk full");
      },
    });
    await expect(wrapCall(() => okAsync("fine"))(callRequest())).resolves.toBe("fine");
  });

  test("captureLogs collects the entries until restored", async () => {
    const logs = captureLogs();
    await wrapCall(() => okAsync(1))(callableRequest({ id: 1 }, { uid: "u9" }));
    expect(logs.entries).toHaveLength(1);
    expect(logs.entries[0]).toMatchObject({ severity: "INFO", authUid: "u9" });
    logs.clear();
    expect(logs.entries).toHaveLength(0);
    logs.restore();
    await wrapCall(() => okAsync(1))(callRequest());
    expect(logs.entries).toHaveLength(0); // restored: the entry went to the platform logger
    expect(writes).toHaveLength(1);
  });

  test("callableRequest carries the data and the signed-in user", () => {
    expect(callableRequest({ a: 1 }, { uid: "u1" })).toMatchObject({ data: { a: 1 }, auth: { uid: "u1" } });
    expect(callableRequest({ a: 1 }).auth).toBeUndefined();
  });

  test("httpExchange records what the handler answered", async () => {
    const { req, res, sent } = httpExchange({ method: "POST", path: "/users", body: { id: 1 } });
    await wrapRequest(() => okAsync({ ok: true }))(req, res);
    expect(sent).toMatchObject({ status: 200, body: { ok: true } });
  });

  test("cloudEvent has an id and a time, so event wrappers see what a real trigger delivers", async () => {
    const event = cloudEvent({ message: { json: { n: 1 } } }, { id: "e7" });
    expect(event).toMatchObject({ id: "e7", data: { message: { json: { n: 1 } } } });
    expect(Date.parse(event.time)).not.toBeNaN();
  });
});

describe("fingerprint", () => {
  const fail = (message: string) => wrapCall(() => errAsync(new DbError(message)))(callRequest()).catch(() => {});

  test("failures of one kind share a fingerprint, whatever their message says", async () => {
    await fail("users read failed for u1");
    await fail("users read failed for u2");
    expect(writes[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(writes[1].fingerprint).toBe(writes[0].fingerprint);
  });

  test("a different kind of failure has a different fingerprint", async () => {
    await fail("x");
    await wrapCall(() => errAsync(new UserNotFound("x")))(callRequest()).catch(() => {});
    await wrapCall(() => {
      throw new Error("boom");
    })(callRequest()).catch(() => {});
    expect(new Set(writes.map((w) => w.fingerprint)).size).toBe(3);
  });

  test("upstream failures are told apart by provider and status class, not by the exact status", async () => {
    const via = (provider: string, status: number) => () =>
      errAsync(toExternalError(provider, Object.assign(new Error("x"), { status })));
    const run = (provider: string, status: number) => wrapCall(via(provider, status))(callRequest()).catch(() => {});
    await run("stripe", 500);
    await run("stripe", 503);
    await run("openai", 503);
    await run("stripe", 429);
    expect(writes[1].fingerprint).toBe(writes[0].fingerprint);
    expect(writes[2].fingerprint).not.toBe(writes[0].fingerprint);
    expect(writes[3].fingerprint).not.toBe(writes[0].fingerprint);
  });

  test("a successful entry has none", async () => {
    await wrapCall(() => okAsync(1))(callRequest());
    expect(writes[0].fingerprint).toBeUndefined();
  });
});

describe("security events", () => {
  const LABELS = "logging.googleapis.com/labels";

  test("an error can declare a security event while the client is told something harmless", async () => {
    class OrderNotFound extends defineError("OrderNotFound", { code: "not-found", securityEvent: "authz_fail" }) {}
    const call = wrapCall(() => errAsync(new OrderNotFound("orders/7 belongs to someone else", { context: { orderId: 7 } })));
    await expect(call(callableRequest({}, { uid: "u1", ip: "203.0.113.5" }))).rejects.toMatchObject({ code: "not-found" });
    expect(writes[0]).toMatchObject({
      severity: "WARNING",
      securityEvent: "authz_fail",
      orderId: 7,
      actor: { uid: "u1", ip: "203.0.113.5" },
      [LABELS]: { security: "authz_fail" },
    });
  });

  test("permission-denied and unauthenticated are authz_fail by default, and securityEvent: false turns that off", async () => {
    class Denied extends defineError("Denied", { code: "permission-denied" }) {}
    class Quiet extends defineError("Quiet", { code: "permission-denied", securityEvent: false }) {}
    await wrapCall(() => errAsync(new Denied("no")))(callableRequest()).catch(() => {});
    await wrapCall(() => errAsync(new Quiet("no")))(callableRequest()).catch(() => {});
    expect(writes[0].securityEvent).toBe("authz_fail");
    expect(writes[1].securityEvent).toBeUndefined();
    expect(writes[1].actor).toBeUndefined();
  });

  test("logContext.security writes at once with the actor, and the final entry lists it", async () => {
    await wrapCall(() => {
      logContext.set({ collection: "patients" });
      logContext.security("sensitive_read", { rows: 3 });
      return okAsync(1);
    })(callableRequest({}, { uid: "u1", ip: "203.0.113.5" }));
    expect(writes[0]).toMatchObject({
      severity: "WARNING",
      message: "sensitive_read",
      securityEvent: "sensitive_read",
      collection: "patients",
      rows: 3,
      actor: { uid: "u1", ip: "203.0.113.5" },
      [LABELS]: { security: "sensitive_read" },
    });
    expect(writes[1]).toMatchObject({ severity: "INFO", securityEvents: ["sensitive_read"], actor: { uid: "u1" } });
    expect(writes[1].securityEvent).toBeUndefined(); // the immediate entry is the event: the final one is only a pointer
    expect(writes[1][LABELS]).toBeUndefined();
  });

  test("the severity can be chosen, and an invocation with a security event is never sampled away", async () => {
    configure({ successSampleRate: 0 });
    await wrapCall(() => {
      logContext.security("malicious_direct_reference", {}, { severity: "CRITICAL" });
      return okAsync(1);
    })(callableRequest({}, { uid: "u1" }));
    expect(writes.map((w) => w.severity)).toEqual(["CRITICAL", "INFO"]);
  });

  test("outside a wrapped handler it still writes, without an actor", () => {
    logContext.security("authz_fail", { where: "startup" });
    expect(writes).toEqual([expect.objectContaining({ severity: "WARNING", securityEvent: "authz_fail", where: "startup" })]);
    expect(writes[0].actor).toBeUndefined();
  });

  test("the actor says whether App Check vouched for the call", async () => {
    const audited = (request: Parameters<ReturnType<typeof wrapCall>>[0]) =>
      wrapCall(() => {
        logContext.audit("sensitive_read");
        return okAsync(1);
      })(request);
    await audited(callableRequest({}, { uid: "u1", app: { appId: "1:app:web" } }));
    await audited(callableRequest({}, { uid: "u1" }));
    expect(writes[0].actor).toMatchObject({ appCheck: "verified", appId: "1:app:web" });
    expect(writes[2].actor).toMatchObject({ appCheck: "missing" });
  });

  test("a replayed App Check token is a CRITICAL authn_token_reuse event", async () => {
    await wrapCall(() => okAsync(1))(callableRequest({}, { uid: "u1", app: { appId: "1:app:web", alreadyConsumed: true } }));
    expect(writes[0]).toMatchObject({
      severity: "CRITICAL",
      securityEvent: "authn_token_reuse",
      actor: { appCheck: "replayed", appId: "1:app:web" },
    });
    expect(writes[1]).toMatchObject({ severity: "INFO", securityEvents: ["authn_token_reuse"] }); // recorded, not rejected
  });
});

describe("actor on every entry", () => {
  test("by default only audit and security entries carry the actor", async () => {
    await wrapCall(() => okAsync(1))(callableRequest({}, { uid: "u1", ip: "203.0.113.5" }));
    expect(writes[0].actor).toBeUndefined();
  });

  test("configure({ actor: 'all' }) puts it on every entry, successes and failures", async () => {
    configure({ actor: "all" });
    await wrapCall(() => okAsync(1))(callableRequest({}, { uid: "u1", ip: "203.0.113.5" }));
    await wrapCall(() => errAsync(new UserNotFound("x")))(callableRequest({}, { uid: "u2", ip: "198.51.100.1" })).catch(() => {});
    expect(writes[0].actor).toMatchObject({ uid: "u1", ip: "203.0.113.5", userAgent: "test", appCheck: "missing" });
    expect(writes[1].actor).toMatchObject({ uid: "u2", ip: "198.51.100.1" });
  });

  test("HTTP requests have one too, and events and unsigned callers only what they have", async () => {
    configure({ actor: "all" });
    const { req, res } = httpExchange({ headers: { "x-forwarded-for": "198.51.100.1" } });
    await wrapRequest(() => okAsync(1))(req, res);
    await wrapEvent(() => okAsync(undefined))(cloudEvent({}, { id: "e1" }));
    expect(writes[0].actor).toMatchObject({ ip: "127.0.0.1", forwardedFor: "198.51.100.1", userAgent: "test" });
    expect(writes[1].actor).toBeUndefined(); // nobody made an event
  });
});

describe("wrapBlocking", () => {
  const LABELS = "logging.googleapis.com/labels";
  const signIn = (provider = "google.com") => `providers/cloud.auth/eventTypes/user.beforeSignIn:${provider}`;
  const signUp = (provider = "password") => `providers/cloud.auth/eventTypes/user.beforeCreate:${provider}`;

  test("a sign-in is an audit event that says where it came from", async () => {
    await wrapBlocking(() => okAsync(undefined))(
      authBlockingEvent({ uid: "u1", ipAddress: "203.0.113.5", userAgent: "Mozilla", eventType: signIn() }),
    );
    expect(writes[0]).toMatchObject({
      severity: "NOTICE",
      auditEvent: "authn_login_success",
      actor: { uid: "u1", ip: "203.0.113.5", userAgent: "Mozilla", signInProvider: "google.com" },
      [LABELS]: { audit: "true" },
    });
    expect(writes[1]).toMatchObject({ severity: "INFO", auditEvents: ["authn_login_success"], eventType: signIn() });
  });

  test("a sign-up is user_created", async () => {
    await wrapBlocking(() => okAsync(undefined))(authBlockingEvent({ uid: "u2", eventType: signUp() }));
    expect(writes[0]).toMatchObject({ auditEvent: "user_created", actor: { uid: "u2", signInProvider: "password" } });
  });

  test("what the policy returns goes back to Firebase", async () => {
    const response = { customClaims: { plan: "pro" } };
    await expect(wrapBlocking(() => okAsync(response))(authBlockingEvent({ eventType: signIn() }))).resolves.toBe(response);
  });

  test("a denial reaches the client as an HttpsError and is logged as a failed login", async () => {
    class BlockedAddress extends defineError("BlockedAddress", { code: "permission-denied", publicMessage: "Sign-in is not available." }) {}
    const handler = wrapBlocking(() => errAsync(new BlockedAddress("address is on the deny list")));
    await expect(handler(authBlockingEvent({ uid: "u1", ipAddress: "203.0.113.5", eventType: signIn() }))).rejects.toMatchObject({
      code: "permission-denied",
      message: "Sign-in is not available.",
    });
    expect(writes).toHaveLength(1); // no success audit event for a sign-in that was refused
    expect(writes[0]).toMatchObject({
      severity: "WARNING",
      securityEvent: "authn_login_fail",
      actor: { uid: "u1", ip: "203.0.113.5" },
      [LABELS]: { security: "authn_login_fail" },
    });
  });

  test("an error that names its own security event keeps it", async () => {
    class Scripted extends defineError("Scripted", { code: "permission-denied", securityEvent: "malicious_attack_tool" }) {}
    await wrapBlocking(() => errAsync(new Scripted("curl")))(authBlockingEvent({ eventType: signIn() })).catch(() => {});
    expect(writes[0].securityEvent).toBe("malicious_attack_tool");
  });

  test("a policy that breaks denies the sign-in, unless failOpen says availability matters more", async () => {
    const broken = () => {
      throw new Error("policy store down");
    };
    await expect(wrapBlocking(broken)(authBlockingEvent({ eventType: signIn() }))).rejects.toMatchObject({ code: "internal" });
    expect(writes[0]).toMatchObject({ severity: "ERROR" });
    expect(writes[0].securityEvent).toBeUndefined(); // a bug in the policy is not an attack
    await expect(wrapBlocking(broken, { failOpen: true })(authBlockingEvent({ eventType: signIn() }))).resolves.toBeUndefined();
    expect(writes[1]).toMatchObject({ severity: "ERROR" }); // still logged
  });

  test("failOpen never overrides a policy's own denial", async () => {
    class Denied extends defineError("Denied", { code: "permission-denied" }) {}
    const handler = wrapBlocking(() => errAsync(new Denied("no")), { failOpen: true });
    await expect(handler(authBlockingEvent({ eventType: signIn() }))).rejects.toMatchObject({ code: "permission-denied" });
  });

  test("the platform allows 7 seconds, whatever the global timeout says", async () => {
    configure({ timeoutSeconds: 0.05, timeoutMarginMs: 10 }); // would cut a 100 ms handler off for any other trigger
    const slow = wrapBlocking(async () => {
      await sleep(100);
      return ok(undefined);
    });
    await expect(slow(authBlockingEvent({ eventType: signIn() }))).resolves.toBeUndefined();
    const guarded = wrapBlocking(
      async () => {
        await sleep(300);
        return ok(undefined);
      },
      { timeoutSeconds: 0.06, timeoutMarginMs: 20 },
    );
    await expect(guarded(authBlockingEvent({ eventType: signIn() }))).rejects.toMatchObject({ code: "deadline-exceeded" });
  });
});

describe("the success line", () => {
  const service = process.env.K_SERVICE;
  afterEach(() => {
    if (service === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = service;
  });

  test("names the function, the outcome and the time", async () => {
    process.env.K_SERVICE = "getuser";
    await wrapCall(() => okAsync(1))(callRequest());
    expect(writes[0].message).toBe(`getuser ok ${writes[0].durationMs} ms`);
  });

  test("starts with the outcome when the platform gives no service name", async () => {
    delete process.env.K_SERVICE;
    await wrapCall(() => okAsync(1))(callRequest());
    expect(writes[0].message).toBe(`ok ${writes[0].durationMs} ms`);
  });
});

describe("httpRequest", () => {
  const latency = expect.stringMatching(/^\d+\.\d{3}s$/);
  const get = (path = "/orders") => httpExchange({ method: "GET", path });
  const call = (fn: () => any) => wrapCall(fn)(callableRequest({}, { uid: "u1" }));

  test("a callable's entry has the method, path, status and latency Cloud Logging shows and filters on", async () => {
    await call(() => okAsync(1));
    expect(writes[0].httpRequest).toEqual({ requestMethod: "POST", requestUrl: "/", status: 200, latency });
  });

  test("the status is the HTTP status of the error code, the one the client receives", async () => {
    await call(() => errAsync(new UserNotFound("x"))).catch(() => {});
    await call(() => errAsync(new DbError("x"))).catch(() => {});
    await call(() => errAsync(new AppError("x", { code: "unavailable" }))).catch(() => {});
    expect(writes.map((w) => w.httpRequest.status)).toEqual([404, 500, 503]);
  });

  test("a thrown exception and the timeout guard are 500 and 504", async () => {
    await call(() => {
      throw new Error("boom");
    }).catch(() => {});
    configure({ timeoutSeconds: 0.05, timeoutMarginMs: 10 });
    await call(() => new Promise(() => {})).catch(() => {});
    expect(writes.map((w) => w.httpRequest.status)).toEqual([500, 504]);
  });

  test("the address and user agent appear only where the actor does", async () => {
    await call(() => okAsync(1));
    expect(writes[0].httpRequest.remoteIp).toBeUndefined();
    expect(writes[0].httpRequest.userAgent).toBeUndefined();

    await call(() => errAsync(new AppError("no", { code: "permission-denied" }))).catch(() => {}); // a denial records the actor
    expect(writes[1].httpRequest).toMatchObject({ status: 403, remoteIp: "127.0.0.1", userAgent: "test" });

    configure({ actor: "all" });
    await call(() => okAsync(1));
    expect(writes[2].httpRequest).toMatchObject({ status: 200, remoteIp: "127.0.0.1", userAgent: "test" });
  });

  test("remoteIp is an address: whatever a forged X-Forwarded-For says is left out, the actor keeps it", async () => {
    configure({ actor: "all" });
    await call(() => okAsync(1));
    await wrapCall(() => okAsync(1))(callableRequest({}, { uid: "u1", ip: "::ffff:203.0.113.7" }));
    await wrapCall(() => okAsync(1))(callableRequest({}, { uid: "u1", ip: "not an address" }));
    expect(writes.map((w) => w.httpRequest.remoteIp)).toEqual(["127.0.0.1", "::ffff:203.0.113.7", undefined]);
    expect(writes[2].actor.ip).toBe("not an address");
  });

  test("wrapRequest records the method and path, and 200 for Ok", async () => {
    const { req, res } = get();
    await wrapRequest(() => okAsync({ id: 1 }))(req, res);
    expect(writes[0].httpRequest).toEqual({ requestMethod: "GET", requestUrl: "/orders", status: 200, latency });
  });

  test("wrapRequest records the status of the error it answered with", async () => {
    const { req, res, sent } = get();
    await wrapRequest(() => errAsync(new UserNotFound("x")))(req, res);
    expect(sent.status).toBe(404);
    expect(writes[0].httpRequest.status).toBe(404);
  });

  test("a response the handler sent itself decides the status", async () => {
    const { req, res } = get();
    await wrapRequest((_req, response) => {
      response.status(201).json({ created: true });
      return ok(undefined);
    })(req, res);
    expect(writes[0].httpRequest.status).toBe(201);
  });

  test("a secret in the path is redacted like any other value", async () => {
    const { req, res } = get("/reset?token=abcdefghijklmnop0123"); // Express leaves the query out of req.path; a rewrite may not
    await wrapRequest(() => okAsync(1))(req, res);
    expect(JSON.stringify(writes[0].httpRequest)).not.toContain("abcdefghijklmnop0123");
  });

  test("events and blocking functions have no request to describe", async () => {
    await wrapEvent((_event: unknown) => okAsync(undefined))(cloudEvent({}));
    await wrapBlocking(() => okAsync(undefined))(authBlockingEvent());
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.httpRequest === undefined)).toBe(true);
  });
});

describe("the context Error Reporting shows", () => {
  const callerOf = () => callableRequest({}, { uid: "u1" });

  test("an ERROR names the user and the request, in the fields Error Reporting documents", async () => {
    await wrapCall(() => errAsync(new DbError("db down")))(callerOf()).catch(() => {});
    expect(writes[0]).toMatchObject({ severity: "ERROR", "@type": expect.stringContaining("ReportedErrorEvent") });
    expect(writes[0].context).toEqual({ user: "u1", httpRequest: { method: "POST", url: "/", responseStatusCode: 500 } });
  });

  test("an HTTP function has the request but no user", async () => {
    const { req, res } = httpExchange({ method: "GET", path: "/orders" });
    await wrapRequest(() => errAsync(new DbError("db down")))(req, res);
    expect(writes[0].context).toEqual({ httpRequest: { method: "GET", url: "/orders", responseStatusCode: 500 } });
  });

  test("the address and user agent follow the actor rule here too", async () => {
    await wrapCall(() => errAsync(new DbError("db down")))(callerOf()).catch(() => {});
    expect(writes[0].context.httpRequest.remoteIp).toBeUndefined();
    configure({ actor: "all" });
    await wrapCall(() => errAsync(new DbError("db down")))(callerOf()).catch(() => {});
    expect(writes[1].context.httpRequest).toMatchObject({ remoteIp: "127.0.0.1", userAgent: "test" });
  });

  test("WARNING and INFO entries carry none", async () => {
    await wrapCall(() => errAsync(new UserNotFound("x")))(callerOf()).catch(() => {});
    await wrapCall(() => okAsync(1))(callerOf());
    expect(writes.map((w) => w.context)).toEqual([undefined, undefined]);
  });

  test("an event has nothing to name, so no context is written", async () => {
    await wrapEvent((_event: unknown) => errAsync(new DbError("db down")))(cloudEvent({})).catch(() => {});
    expect(writes[0]).toMatchObject({ severity: "ERROR" });
    expect(writes[0].context).toBeUndefined();
  });
});
