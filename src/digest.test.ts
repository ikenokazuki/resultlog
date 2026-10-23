import { describe, expect, test } from "bun:test";
import { digest, parseLogs } from "./digest.js";

// Entries as resultlog writes them, and as `gcloud logging read --format=json` returns them.
const success = (o: Record<string, unknown> = {}) => ({
  severity: "INFO",
  message: "getuser ok 42 ms",
  authUid: "u1",
  durationMs: 100,
  ...o,
});
const failure = (o: Record<string, unknown> = {}) => ({
  severity: "ERROR",
  message: "DbError: users read failed for u1\n    at findUser (users.ts:12:5)",
  errorName: "DbError",
  errorCode: "internal",
  fingerprint: "aaaaaaaaaaaa",
  retryable: true,
  authUid: "u1",
  durationMs: 50,
  ...o,
});
const asGcloud = (entry: Record<string, unknown>, service = "on-order", timestamp = "2026-10-22T10:00:00Z") => {
  const { severity, ...jsonPayload } = entry;
  return { severity, jsonPayload, timestamp, resource: { type: "cloud_run_revision", labels: { service_name: service } } };
};
const at = (minute: number) => `2026-10-22T10:${String(minute).padStart(2, "0")}:00Z`;

describe("digest", () => {
  test("reads both the gcloud shape and plain entries", () => {
    const plain = digest([success(), failure()]).data;
    const fromGcloud = digest([asGcloud(success()), asGcloud(failure())]).data;
    expect(fromGcloud.entries).toBe(2);
    expect(fromGcloud.invocations).toBe(plain.invocations);
    expect(fromGcloud.failures[0]).toMatchObject({ name: "DbError", count: 1, services: ["on-order"] });
  });

  test("says so when there is nothing to read", () => {
    expect(digest([{ unrelated: true }, "text", null]).markdown).toContain("No resultlog entries");
  });

  test("reports the window, the severities and the services", () => {
    const logs = [
      asGcloud(success({ durationMs: 100, coldStart: true }), "a", at(0)),
      asGcloud(success({ durationMs: 300 }), "a", at(10)),
      asGcloud(success({ durationMs: 200 }), "a", at(20)),
      asGcloud(failure(), "a", at(30)),
      asGcloud(success({ durationMs: 40 }), "b", at(5)),
    ];
    const { data } = digest(logs);
    expect(data.window).toEqual({ from: at(0), to: at(30) });
    expect(data.severities).toEqual({ INFO: 4, ERROR: 1 });
    const a = data.services.find((s) => s.name === "a");
    expect(a).toMatchObject({ invocations: 4, failures: 1, coldStarts: 1, p50Ms: 100, p95Ms: 300 });
    expect(a?.failureRate).toBeCloseTo(0.25);
  });

  test("counts sampled successes at their weight, so rates stay right", () => {
    const { data } = digest([success({ sampleRate: 0.1 }), failure()]);
    expect(data.invocations).toBe(11); // one kept success stands for ten
    expect(data.services[0]?.failureRate).toBeCloseTo(1 / 11);
  });

  test("groups failures by fingerprint and ranks them by count", () => {
    const logs = [
      asGcloud(failure({ message: "DbError: users read failed for u1" }), "a", at(1)),
      asGcloud(failure({ message: "DbError: users read failed for u2" }), "b", at(9)),
      asGcloud(failure({ message: "DbError: users read failed for u3" }), "a", at(4)),
      asGcloud(
        failure({
          fingerprint: "bbbbbbbbbbbb",
          errorName: "UserNotFound",
          errorCode: "not-found",
          severity: "WARNING",
          retryable: false,
          message: "users/u9 missing",
        }),
        "a",
        at(2),
      ),
    ];
    const { data } = digest(logs);
    expect(data.failures.map((g) => [g.fingerprint, g.count])).toEqual([
      ["aaaaaaaaaaaa", 3],
      ["bbbbbbbbbbbb", 1],
    ]);
    expect(data.failures[0]).toMatchObject({
      name: "DbError",
      code: "internal",
      severity: "ERROR",
      services: ["a", "b"],
      first: at(1),
      last: at(9),
      retryable: true,
      message: "DbError: users read failed for u1",
    });
  });

  test("failures without a fingerprint (older entries) are grouped by name, code and message shape", () => {
    const old = (n: number) => {
      const { fingerprint: _drop, ...rest } = failure({ message: `Timeout after ${n} ms for order 55${n}` });
      return rest;
    };
    expect(digest([old(100), old(250), old(900)]).data.failures).toHaveLength(1);
  });

  test("keeps the breadcrumbs and the upstream calls that came with a failure", () => {
    const entry = failure({
      breadcrumbs: [
        { level: "DEBUG", message: "looked up user" },
        { level: "DEBUG", message: "calling the model" },
      ],
      external: { "api.openai.com": { calls: 1, statuses: { "503": 1 }, totalMs: 900, maxMs: 900 } },
      trace: "projects/p/traces/abc",
    });
    const [group] = digest([entry]).data.failures;
    expect(group?.breadcrumbs).toEqual(["looked up user", "calling the model"]);
    expect(group?.upstream).toEqual({ "api.openai.com": "5xx×1" });
  });

  test("summarizes security events, the actors behind them, and the busiest minute", () => {
    const denied = (uid: string, minute: number) =>
      asGcloud(
        failure({
          severity: "WARNING",
          errorName: "AppError",
          errorCode: "permission-denied",
          fingerprint: "cccccccccccc",
          securityEvent: "authz_fail",
          actor: { uid, ip: "203.0.113.5", userAgent: "curl/8" },
        }),
        "admin",
        at(minute),
      );
    const logs = [denied("mallory", 7), denied("mallory", 7), denied("mallory", 7), denied("bob", 8)];
    logs.push(
      asGcloud(
        { severity: "NOTICE", message: "authz_change", auditEvent: "authz_change", actor: { uid: "admin1", ip: "198.51.100.2" }, target: "users/u9", role: "admin" },
        "admin",
        at(9),
      ),
    );
    const { data } = digest(logs);
    expect(data.security.events).toEqual({ authz_fail: 4 });
    expect(data.security.actors[0]).toMatchObject({ count: 3 });
    expect(data.security.actors[0]?.who).toContain("mallory");
    expect(data.security.peak).toEqual({ minute: at(7), count: 3 });
    expect(data.security.audit[0]).toMatchObject({ event: "authz_change", actor: "admin1", details: { target: "users/u9", role: "admin" } });
  });

  test("aggregates outgoing calls per host, weighted, worst first", () => {
    const calls = (host: string, stats: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      success({ external: { [host]: stats }, ...extra });
    const { data } = digest([
      calls("api.stripe.com", { calls: 2, statuses: { "200": 2 }, totalMs: 200, maxMs: 120 }),
      calls("api.openai.com", { calls: 3, statuses: { "200": 1, "429": 1 }, errors: 1, totalMs: 6000, maxMs: 4000 }),
    ]);
    expect(data.external.map((h) => h.host)).toEqual(["api.openai.com", "api.stripe.com"]);
    expect(data.external[0]).toMatchObject({ calls: 3, failed: 2, avgMs: 2000, maxMs: 4000, statuses: { "200": 1, "429": 1 } });
    expect(data.external[0]?.failureRate).toBeCloseTo(2 / 3);
  });

  test("totals LLM tokens and cost, per model", () => {
    const llm = (model: string, input: number, output: number, cost: number, more: Record<string, unknown> = {}) =>
      success({ llm: { calls: 1, inputTokens: input, outputTokens: output, cost, models: { [model]: { calls: 1, inputTokens: input, outputTokens: output } }, ...more } });
    const { data } = digest([llm("m-1", 100, 20, 0.5), llm("m-1", 50, 10, 0.25, { truncated: 1 }), llm("m-2", 10, 5, 0.1, { blocked: 1 })]);
    expect(data.llm).toMatchObject({
      calls: 3,
      inputTokens: 160,
      outputTokens: 35,
      truncated: 1,
      blocked: 1,
      models: { "m-1": { calls: 2, inputTokens: 150, outputTokens: 30 }, "m-2": { calls: 1 } },
    });
    expect(data.llm?.cost).toBeCloseTo(0.85);
  });

  test("counts timeouts, duplicates, handled errors and the reasons retries stopped", () => {
    const { data } = digest([
      failure({ errorName: "DeadlineExceeded", errorCode: "deadline-exceeded", fingerprint: "dddddddddddd" }),
      success({ duplicate: true }),
      success({ handledErrors: [{ error: {} }, { error: {} }] }),
      success({ retries: [{ attempts: 3, stoppedBy: "attempts" }, { attempts: 1, stoppedBy: "internal-retry" }] }),
      success({ retries: [{ attempts: 2, outcome: "ok" }] }),
    ]);
    expect(data.reliability).toEqual({
      timeouts: 1,
      duplicates: 1,
      handledErrors: 2,
      retries: { attempts: 1, "internal-retry": 1, recovered: 1 },
      coldStarts: 0,
    });
  });

  test("stays within maxChars by dropping what ranks lowest", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      failure({ fingerprint: String(i).padStart(12, "0"), errorName: `Error${i}`, message: `Error${i}: ${"x".repeat(200)}` }),
    );
    const { markdown } = digest(many, { maxChars: 3000, top: 60 });
    expect(markdown.length).toBeLessThanOrEqual(3000);
    expect(markdown).toContain("# resultlog digest");
    expect(markdown).toMatch(/omitted/);
  });

  test("pseudonymize hides who, but keeps the same person recognizable", () => {
    const denied = (uid: string, ip: string) =>
      failure({ severity: "WARNING", securityEvent: "authz_fail", authUid: uid, actor: { uid, ip, userAgent: "Mozilla" } });
    const { markdown, data } = digest([denied("mallory", "203.0.113.5"), denied("mallory", "203.0.113.5"), denied("bob", "198.51.100.9")], {
      pseudonymize: true,
    });
    const text = markdown + JSON.stringify(data);
    for (const secret of ["mallory", "bob", "203.0.113.5", "198.51.100.9", "Mozilla"]) expect(text).not.toContain(secret);
    expect(data.security.actors).toHaveLength(2);
    expect(data.security.actors[0]?.count).toBe(2);
  });
});

describe("parseLogs", () => {
  test("reads a JSON array, and one JSON value per line", () => {
    expect(parseLogs('[{"a":1},{"a":2}]').logs).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseLogs('{"a":1}\n\n{"a":2}\n').logs).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("counts the lines it could not read instead of failing", () => {
    expect(parseLogs('{"a":1}\nnot json\n{"a":2}')).toEqual({ logs: [{ a: 1 }, { a: 2 }], skipped: 1 });
  });
});

// Entries as resultlog writes them for security and audit events, with timestamps to the second.
const sec = (s: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, s)).toISOString();
const security = (event: string, actor: Record<string, unknown>, seconds: number, extra: Record<string, unknown> = {}) => ({
  severity: "WARNING",
  message: event,
  securityEvent: event,
  actor,
  timestamp: sec(seconds),
  ...extra,
});
const audit = (event: string, actor: Record<string, unknown>, seconds: number, extra: Record<string, unknown> = {}) => ({
  severity: "NOTICE",
  message: event,
  auditEvent: event,
  actor,
  timestamp: sec(seconds),
  ...extra,
});
const visit = (actor: Record<string, unknown>, seconds: number) => success({ actor, timestamp: sec(seconds) });
const repeat = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));

describe("security events from every source", () => {
  test("events that are not failed invocations count too, and an event is counted once", () => {
    const logs = [
      security("sensitive_read", { uid: "u1", ip: "203.0.113.5" }, 0),
      failure({ severity: "WARNING", securityEvent: "authz_fail", actor: { uid: "u2", ip: "198.51.100.1" }, timestamp: sec(5) }),
      success({ securityEvents: ["sensitive_read"], actor: { uid: "u1" }, timestamp: sec(1) }), // the pointer left by the final entry
    ];
    expect(digest(logs).data.security.events).toEqual({ sensitive_read: 1, authz_fail: 1 });
  });
});

describe("findings", () => {
  const findings = (logs: unknown[], options?: Parameters<typeof digest>[1]) => digest(logs, options).data.findings;
  const mallory = { uid: "mallory", ip: "203.0.113.5" };

  test("authz-probing: one actor refused again and again within minutes", () => {
    const logs = [
      ...repeat(12, (i) => security("authz_fail", mallory, i * 10)),
      ...repeat(3, (i) => security("authz_fail", { uid: "bob", ip: "198.51.100.9" }, i * 10)),
      ...repeat(12, (i) => security("authz_fail", { uid: "slow", ip: "192.0.2.7" }, i * 900)), // twelve in three hours: not a burst
    ];
    const [finding, ...rest] = findings(logs);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ rule: "authz-probing", severity: "medium", count: 12, first: sec(0), last: sec(110) });
    expect(finding?.subject).toContain("mallory");
    expect(finding?.hint).toContain("revoke");
  });

  test("validation-fuzzing: one actor sending malformed input in bulk", () => {
    const logs = repeat(25, (i) => security("input_validation_fail", mallory, i * 5));
    expect(findings(logs)).toEqual([expect.objectContaining({ rule: "validation-fuzzing", count: 25 })]);
  });

  test("many-accounts-one-ip: one address behind several accounts", () => {
    const logs = [
      ...repeat(6, (i) => audit("authn_login_success", { uid: `user${i}`, ip: "203.0.113.5" }, i * 120)),
      ...repeat(3, (i) => audit("authn_login_success", { uid: `other${i}`, ip: "198.51.100.1" }, i * 120)),
    ];
    const [finding] = findings(logs);
    expect(finding).toMatchObject({ rule: "many-accounts-one-ip", count: 6 });
    expect(finding?.subject).toBe("ip=203.0.113.5");
    expect(finding?.evidence).toContain("user0");
    expect(findings(logs)).toHaveLength(1);
  });

  test("many-ips-one-account: one account seen from several addresses, in ordinary traffic", () => {
    const logs = repeat(5, (i) => visit({ uid: "alice", ip: `203.0.113.${i + 1}` }, i * 600));
    expect(findings(logs)).toEqual([expect.objectContaining({ rule: "many-ips-one-account", count: 5, subject: "uid=alice" })]);
  });

  test("mass-access: one account reading sensitive data in bulk", () => {
    const logs = repeat(120, (i) => audit("sensitive_read", { uid: "alice", ip: "203.0.113.5" }, i * 2));
    expect(findings(logs)).toEqual([expect.objectContaining({ rule: "mass-access", severity: "high", count: 120 })]);
  });

  test("token-reuse: a replayed App Check token is reported at once", () => {
    const logs = [security("authn_token_reuse", { uid: "alice", ip: "203.0.113.5", appCheck: "replayed" }, 0, { severity: "CRITICAL" })];
    expect(findings(logs)).toEqual([expect.objectContaining({ rule: "token-reuse", severity: "high", count: 1 })]);
  });

  test("privilege changes are listed, and a change by someone who is not an admin is high", () => {
    const logs = [
      audit("authz_change", { uid: "admin1", ip: "198.51.100.2" }, 0, { target: "users/u9" }),
      audit("user_deleted", { uid: "eve", ip: "203.0.113.5" }, 60),
    ];
    expect(findings(logs).map((f) => [f.rule, f.severity])).toEqual([
      ["privilege-change", "info"],
      ["privilege-change", "info"],
    ]);
    const withAdmins = findings(logs, { admins: ["admin1"] });
    const byNonAdmin = withAdmins.filter((f) => f.rule === "privilege-change-by-non-admin");
    expect(byNonAdmin).toHaveLength(1);
    expect(byNonAdmin[0]).toMatchObject({ severity: "high" });
    expect(byNonAdmin[0]?.subject).toContain("eve");
  });

  test("thresholds can be changed per rule", () => {
    const logs = repeat(4, (i) => security("authz_fail", mallory, i * 10));
    expect(findings(logs)).toEqual([]);
    expect(findings(logs, { thresholds: { "authz-probing": 3 } })).toEqual([expect.objectContaining({ rule: "authz-probing", count: 4 })]);
  });

  test("rules of your own: a filter, a key, what to count, a threshold and a window", () => {
    const logs = repeat(6, (i) => success({ actor: { uid: `u${i}`, ip: "203.0.113.5" }, region: "eu", timestamp: sec(i * 30) }));
    const rule = {
      name: "eu-signups-per-ip",
      severity: "low" as const,
      summary: "Many accounts from one address in the EU",
      hint: "Look at the sign-up flow.",
      filter: (p: { fields: Record<string, unknown> }) => p.fields.region === "eu",
      key: (p: { ip?: string }) => p.ip,
      distinct: (p: { uid?: string }) => p.uid,
      threshold: 4,
      windowMs: 10 * 60_000,
    };
    const found = findings(logs, { rules: [rule] }).filter((f) => f.rule === "eu-signups-per-ip");
    expect(found).toEqual([expect.objectContaining({ severity: "low", count: 6, subject: "203.0.113.5" })]);
  });

  test("pseudonymize keeps findings from naming anyone", () => {
    const logs = repeat(12, (i) => security("authz_fail", mallory, i * 10));
    const { data, markdown } = digest(logs, { pseudonymize: true });
    const text = markdown + JSON.stringify(data);
    expect(text).not.toContain("mallory");
    expect(text).not.toContain("203.0.113.5");
    expect(data.findings[0]?.subject).toMatch(/uid=user_[0-9a-f]{6}/);
  });

  test("findings come first in the Markdown, and survive a tight cap", () => {
    const logs = [
      ...repeat(12, (i) => security("authz_fail", mallory, i * 10)),
      ...repeat(40, (i) => failure({ fingerprint: String(i).padStart(12, "0"), errorName: `Error${i}`, message: `Error${i}: ${"x".repeat(200)}` })),
    ];
    const { markdown } = digest(logs, { maxChars: 2500, top: 40 });
    expect(markdown.indexOf("## Findings")).toBeGreaterThan(-1);
    expect(markdown.indexOf("## Findings")).toBeLessThan(markdown.indexOf("## Failure groups"));
    expect(markdown).toContain("authz-probing");
    expect(markdown.length).toBeLessThanOrEqual(2500);
  });

  test("nothing is reported for calm traffic", () => {
    expect(findings([success(), failure(), security("authz_fail", mallory, 0)])).toEqual([]);
  });
});
