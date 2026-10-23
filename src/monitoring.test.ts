import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { configure, defineError, firestoreIdempotency, logContext, wrapCall, wrapEvent } from "./index.js";
import { files, monitoring } from "./monitoring.js";
import { callableRequest, captureLogs, cloudEvent } from "./testing.js";

// ---- A reader for the subset of the Logging query language that the generated filters use -----------------------

type Json = Record<string, any>;

function lookup(entry: Json, path: string): unknown {
  return path.split(".").reduce<any>((value, key) => (value === undefined || value === null ? undefined : value[key]), entry);
}

const SEVERITIES = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];

/**
 * field=value, field:*, field:"part", field=~"re", field>n, field>=n (severity by rank), field=("a" OR "b"), joined by
 * AND / OR, with parentheses. As in Logging: OR binds tighter than AND, and = and : ignore letter case (=~ does not).
 */
function matches(filter: string, entry: Json): boolean {
  const tokens = filter.match(/"(?:[^"\\]|\\.)*"|=~|>=|<=|[()=:<>]|\*|\bAND\b|\bOR\b|[^\s()=:<>"*]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++] as string;
  const unquote = (token: string) => (token.startsWith('"') ? JSON.parse(token) : token);
  const andExpr = (): boolean => {
    let result = orExpr();
    while (peek() === "AND") {
      take();
      const right = orExpr();
      result = result && right;
    }
    return result;
  };
  const orExpr = (): boolean => {
    let result = term();
    while (peek() === "OR") {
      take();
      const right = term();
      result = result || right;
    }
    return result;
  };
  const term = (): boolean => {
    if (peek() === "(") {
      take();
      const inner = andExpr();
      expect(take()).toBe(")");
      return inner;
    }
    const field = take();
    const op = take();
    const actual = lookup(entry, field);
    if (op === ":" && peek() === "*") {
      take();
      return actual !== undefined && actual !== null;
    }
    let expected: string[];
    if (peek() === "(") {
      take();
      expected = [unquote(take())];
      while (peek() === "OR") {
        take();
        expected.push(unquote(take()));
      }
      expect(take()).toBe(")");
    } else {
      expected = [unquote(take())];
    }
    if (actual === undefined || actual === null) return false;
    const text = String(actual).toLowerCase();
    if (op === "=") return expected.some((e) => text === e.toLowerCase());
    if (op === ":") return expected.some((e) => text.includes(e.toLowerCase()));
    if (op === "=~") return expected.some((e) => new RegExp(e).test(String(actual)));
    const [a, b] = field === "severity" ? [SEVERITIES.indexOf(String(actual)), SEVERITIES.indexOf(expected[0] as string)] : [Number(actual), Number(expected[0])];
    if (op === ">") return a > b;
    if (op === "<") return a < b;
    if (op === ">=") return a >= b;
    if (op === "<=") return a <= b;
    throw new Error(`unsupported operator ${op}`);
  };
  const result = andExpr();
  expect(at).toBe(tokens.length); // the whole filter was understood
  return result;
}

/** A log entry as Cloud Logging stores what resultlog wrote: `severity` is lifted out of the payload. */
const asLogEntry = (entry: Json, service = "on-order"): Json => {
  const { severity, httpRequest, ...jsonPayload } = entry; // Cloud Logging lifts both out of the payload
  return { severity, httpRequest, jsonPayload, resource: { type: "cloud_run_revision", labels: { service_name: service } } };
};

// ---- Entries written by the library itself --------------------------------------------------------------------

class DbError extends defineError("DbError", { code: "internal" }) {}
class NotFound extends defineError("NotFound", { code: "not-found" }) {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const logs = captureLogs();
let previous: Parameters<typeof configure>[0];
beforeEach(() => {
  logs.clear();
  previous = { successSampleRate: 1, timeoutSeconds: undefined, timeoutMarginMs: 1000 };
});
afterEach(() => configure(previous));

/** Runs real invocations and returns the entries they wrote, by scenario. */
async function scenarios() {
  const out: Record<string, Json[]> = {};
  const run = async (name: string, body: () => Promise<unknown>) => {
    logs.clear();
    await body().catch(() => {});
    out[name] = logs.entries.map((e) => ({ ...e }));
  };
  await run("success", () => wrapCall(() => okAsync(1))(callableRequest({}, { uid: "u1" })));
  await run("error", () => wrapCall(() => errAsync(new DbError("db down")))(callableRequest({}, { uid: "u1" })));
  await run("warning", () => wrapCall(() => errAsync(new NotFound("missing")))(callableRequest({}, { uid: "u1" })));
  await run("denied", () => wrapCall(() => errAsync(new (defineError("Denied", { code: "permission-denied" }))("no")))(callableRequest({}, { uid: "u1" })));
  await run("security", () =>
    wrapCall(() => {
      logContext.security("sensitive_read", { rows: 3 });
      return okAsync(1);
    })(callableRequest({}, { uid: "u1" })),
  );
  await run("replay", () => wrapCall(() => okAsync(1))(callableRequest({}, { uid: "u1", app: { appId: "a", alreadyConsumed: true } })));
  await run("audit", () =>
    wrapCall(() => {
      logContext.audit("authz_change", { target: "users/u9" });
      return okAsync(1);
    })(callableRequest({}, { uid: "u1" })),
  );
  await run("audit-read", () =>
    wrapCall(() => {
      logContext.audit("sensitive_read");
      return okAsync(1);
    })(callableRequest({}, { uid: "u1" })),
  );
  await run("timeout", async () => {
    configure({ timeoutSeconds: 0.06, timeoutMarginMs: 20 });
    await wrapCall(async () => {
      await sleep(300);
      return okAsync(1);
    })(callableRequest());
  });
  configure({ timeoutSeconds: undefined, timeoutMarginMs: 1000 });
  const seen = new Set<string>();
  const store = {
    claim: async (key: string) => (seen.has(key) ? ("done" as const) : (seen.add(key), "claimed" as const)),
    complete: async () => {},
    release: async () => {},
  };
  const event = cloudEvent({}, { id: "evt-1" });
  await run("event-first", () => wrapEvent(() => okAsync(undefined), { idempotency: store })(event));
  await run("duplicate", () => wrapEvent(() => okAsync(undefined), { idempotency: store })(event));
  const llm = (response: unknown) => () =>
    wrapCall(() => {
      logContext.llm(response);
      return okAsync(1);
    })(callableRequest());
  await run("llm-truncated", llm({ finish_reason: "length", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  await run("llm-blocked", llm({ finishReason: "SAFETY", usage: { inputTokens: 1, outputTokens: 1 } }));
  await run("llm-fine", llm({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
  await run("llm-interrupted", () =>
    wrapCall(async () => {
      const stream = (async function* () {
        yield { model: "m" };
        throw new Error("overloaded");
      })();
      for await (const _chunk of logContext.llm(stream)) {
        // consume
      }
      return okAsync(1);
    })(callableRequest()),
  );
  return out;
}

const options = { project: "my-project-123" };
const all = <T>(map: Record<string, T[]>) => Object.values(map).flat();

describe("input is checked, because it ends up in filters and in shell commands", () => {
  test.each([
    ["project", { project: "My Project; rm -rf /" }],
    ["project", { project: "x" }],
    ["prefix", { project: "my-project-123", prefix: "Bad Prefix" }],
    ["services", { project: "my-project-123", services: ["ok", "not ok$(id)"] }],
    ["notificationChannels", { project: "my-project-123", notificationChannels: ["channel-1"] }],
    ["thresholds", { project: "my-project-123", thresholds: { errors: -1 } }],
  ])("a bad %s is refused", (_name, input) => {
    expect(() => monitoring(input as never)).toThrow();
  });
});

describe("log-based metrics", () => {
  test("every metric counts entries, and every label has an extractor and the other way round", () => {
    const { metrics } = monitoring(options);
    expect(Object.keys(metrics).sort()).toEqual(
      [
        "resultlog_audit_events",
        "resultlog_cold_starts",
        "resultlog_duplicate_events",
        "resultlog_failures",
        "resultlog_llm_blocked",
        "resultlog_llm_interrupted",
        "resultlog_llm_truncated",
        "resultlog_security_events",
        "resultlog_timeouts",
      ].sort(),
    );
    for (const [name, metric] of Object.entries(metrics)) {
      expect(metric.name).toBe(name);
      expect(metric.metricDescriptor).toMatchObject({ metricKind: "DELTA", valueType: "INT64", unit: "1" });
      const labels = (metric.metricDescriptor.labels ?? []).map((l: Json) => l.key).sort();
      expect(Object.keys(metric.labelExtractors ?? {}).sort()).toEqual(labels);
      expect(metric.filter).toContain('resource.type="cloud_run_revision"');
      expect((metric.metricDescriptor.labels ?? []).length).toBeLessThanOrEqual(3); // cardinality: only labels with few values
    }
  });

  test("no label can hold a user id or an address", () => {
    const { metrics } = monitoring(options);
    const extractors = Object.values(metrics).flatMap((m) => Object.values(m.labelExtractors ?? {})).join(" ");
    expect(extractors).not.toMatch(/uid|actor|ip|userAgent|authUid|eventId|trace|fingerprint/i);
  });

  test("a prefix and a list of functions change the names and the scope", () => {
    const { metrics } = monitoring({ ...options, prefix: "shop", services: ["checkout", "on-order"] });
    expect(Object.keys(metrics)).toContain("shop_failures");
    expect(metrics.shop_failures?.filter).toContain('resource.labels.service_name=("checkout" OR "on-order")');
  });

  test("each filter matches the entries the library writes for it, and no others", async () => {
    const entries = await scenarios();
    const { metrics } = monitoring(options);
    const countIn = (metric: string, scenario: string) =>
      (entries[scenario] ?? []).filter((e) => matches(metrics[metric]?.filter as string, asLogEntry(e))).length;
    const total = (metric: string) => all(entries).filter((e) => matches(metrics[metric]?.filter as string, asLogEntry(e))).length;

    // failures: the final entry of an invocation that ended in an error, not the success or the audit entries
    expect(countIn("resultlog_failures", "error")).toBe(1);
    expect(countIn("resultlog_failures", "warning")).toBe(1);
    expect(countIn("resultlog_failures", "success")).toBe(0);
    expect(countIn("resultlog_failures", "audit")).toBe(0);
    // security events: the immediate entry and a failure that is one, but not the pointer in the final entry
    expect(countIn("resultlog_security_events", "security")).toBe(1);
    expect(countIn("resultlog_security_events", "denied")).toBe(1);
    expect(countIn("resultlog_security_events", "replay")).toBe(1);
    expect(countIn("resultlog_security_events", "success")).toBe(0);
    expect(countIn("resultlog_audit_events", "audit")).toBe(1);
    expect(countIn("resultlog_audit_events", "security")).toBe(0);
    expect(countIn("resultlog_timeouts", "timeout")).toBe(1);
    expect(total("resultlog_timeouts")).toBe(1);
    expect(total("resultlog_duplicate_events")).toBe(1);
    expect(countIn("resultlog_duplicate_events", "duplicate")).toBe(1);
    expect(total("resultlog_llm_truncated")).toBe(1);
    expect(total("resultlog_llm_blocked")).toBe(1);
    expect(total("resultlog_llm_interrupted")).toBe(1);
    expect(countIn("resultlog_llm_truncated", "llm-fine")).toBe(0);
    // the first entry of an instance is a cold start, and only one is
    expect(total("resultlog_cold_starts")).toBeLessThanOrEqual(1);
  });

  test("a metric scoped to some functions leaves the others out", async () => {
    const entries = await scenarios();
    const { metrics } = monitoring({ ...options, services: ["checkout"] });
    const filter = metrics.resultlog_failures?.filter as string;
    const error = entries.error?.[0] as Json;
    expect(matches(filter, asLogEntry(error, "checkout"))).toBe(true);
    expect(matches(filter, asLogEntry(error, "on-order"))).toBe(false);
  });

  test("label extractors read fields that exist in the entries", async () => {
    const entries = await scenarios();
    const { metrics } = monitoring(options);
    const extract = (metric: string, entry: Json, label: string) => {
      const expression = metrics[metric]?.labelExtractors?.[label] as string;
      const path = expression.replace(/^EXTRACT\((.*)\)$/, "$1");
      return lookup(asLogEntry(entry), path);
    };
    expect(extract("resultlog_failures", entries.error?.[0] as Json, "error_name")).toBe("DbError");
    expect(extract("resultlog_failures", entries.error?.[0] as Json, "error_code")).toBe("internal");
    expect(extract("resultlog_failures", entries.error?.[0] as Json, "severity")).toBe("ERROR");
    expect(extract("resultlog_security_events", entries.security?.[0] as Json, "event")).toBe("sensitive_read");
    expect(extract("resultlog_audit_events", entries.audit?.[0] as Json, "event")).toBe("authz_change");
  });
});

describe("alert policies", () => {
  const channel = "projects/my-project-123/notificationChannels/1234567890";

  test("each one has a name, documentation that says what to do, and the channels you gave", () => {
    const { alerts } = monitoring({ ...options, notificationChannels: [channel] });
    expect(Object.keys(alerts).length).toBeGreaterThanOrEqual(6);
    for (const policy of Object.values(alerts)) {
      expect(policy.displayName).toMatch(/^resultlog: /);
      expect(policy.enabled).toBe(true);
      expect(policy.notificationChannels).toEqual([channel]);
      expect(policy.documentation.mimeType).toBe("text/markdown");
      expect(policy.documentation.content).toMatch(/resultlog digest|gcloud logging read/);
      expect(policy.userLabels).toEqual({ source: "resultlog" });
    }
    expect(new Set(Object.values(alerts).map((p) => p.displayName)).size).toBe(Object.keys(alerts).length);
  });

  test("without channels they are created without any (you add them in the console)", () => {
    for (const policy of Object.values(monitoring(options).alerts)) expect(policy.notificationChannels).toEqual([]);
  });

  test("threshold conditions count a metric per period, per function, and use only what the API accepts", () => {
    const { alerts, metrics } = monitoring(options);
    const thresholds = Object.values(alerts).flatMap((p) => p.conditions).filter((c: Json) => c.conditionThreshold);
    expect(thresholds.length).toBeGreaterThanOrEqual(4);
    for (const condition of thresholds as Json[]) {
      const t = condition.conditionThreshold;
      const metric = /metric\.type="logging\.googleapis\.com\/user\/([a-z_]+)"/.exec(t.filter)?.[1] as string;
      expect(Object.keys(metrics)).toContain(metric); // it watches a metric that is created
      expect(t.comparison).toBe("COMPARISON_GT"); // the API supports only GT and LT
      expect(t.duration).toMatch(/^\d+s$/);
      expect(Number.parseInt(t.duration, 10) % 60).toBe(0); // a multiple of a minute
      expect(t.aggregations).toHaveLength(1);
      expect(t.aggregations[0]).toMatchObject({ perSeriesAligner: "ALIGN_DELTA", crossSeriesReducer: "REDUCE_SUM" });
      expect(Number.parseInt(t.aggregations[0].alignmentPeriod, 10)).toBeGreaterThanOrEqual(60);
      expect(t.aggregations[0].groupByFields).toContain("resource.label.service_name");
      expect(t.trigger).toEqual({ count: 1 });
    }
  });

  test("thresholds can be changed by name", () => {
    const { alerts } = monitoring({ ...options, thresholds: { errors: 12, "security-events": 7 } });
    const value = (title: string) =>
      (Object.values(alerts).find((p) => p.displayName.includes(title))?.conditions[0] as Json).conditionThreshold.thresholdValue;
    expect(value("server errors")).toBe(12);
    expect(value("security events")).toBe(7);
  });

  test("the server error alert ignores warnings, which are expected failures", () => {
    const policy = Object.values(monitoring(options).alerts).find((p) => p.displayName.includes("server errors")) as Json;
    expect(policy.conditions[0].conditionThreshold.filter).toContain('metric.label.severity=one_of("ERROR"');
    expect(policy.conditions[0].conditionThreshold.filter).not.toContain("WARNING");
  });

  test("the alerts for rare, serious events are log-based: they notify on the entry itself, alone in their policy", async () => {
    const entries = await scenarios();
    const { alerts } = monitoring(options);
    const logBased = Object.values(alerts).filter((p) => p.conditions.some((c: Json) => c.conditionMatchedLog));
    expect(logBased.map((p) => p.displayName).sort()).toEqual([
      "resultlog: App Check token replayed",
      "resultlog: Firebase Security Rules changed",
      "resultlog: Firebase project or API key changed",
      "resultlog: IAM policy changed",
      "resultlog: permissions or accounts changed",
      "resultlog: service account key created",
    ]);
    for (const policy of logBased) {
      expect(policy.conditions).toHaveLength(1); // a log match must be the only condition
      expect(policy.alertStrategy.notificationRateLimit.period).toMatch(/^\d+s$/); // required for log-based alerts
    }
    const filterOf = (title: string) => (logBased.find((p) => p.displayName.includes(title))?.conditions[0] as Json).conditionMatchedLog.filter;
    expect(logBased.find((p) => p.displayName.includes("replayed"))?.severity).toBe("CRITICAL");
    expect(matches(filterOf("replayed"), asLogEntry(entries.replay?.[0] as Json))).toBe(true);
    expect(matches(filterOf("replayed"), asLogEntry(entries.security?.[0] as Json))).toBe(false);
    expect(matches(filterOf("permissions or accounts changed"), asLogEntry(entries.audit?.[0] as Json))).toBe(true);
    expect(matches(filterOf("permissions or accounts changed"), asLogEntry(entries["audit-read"]?.[0] as Json))).toBe(false);
  });

  test("the LLM alert watches the three kinds of bad answer, as separate conditions in one policy", () => {
    const policy = Object.values(monitoring(options).alerts).find((p) => p.displayName.includes("LLM")) as Json;
    expect(policy.combiner).toBe("OR");
    expect(policy.conditions).toHaveLength(3);
  });

  test("every key is one the Cloud Monitoring API defines", () => {
    const allowed = {
      policy: ["displayName", "documentation", "userLabels", "conditions", "combiner", "enabled", "notificationChannels", "alertStrategy", "severity"],
      documentation: ["content", "mimeType", "subject"],
      condition: ["displayName", "conditionThreshold", "conditionMatchedLog"],
      threshold: ["filter", "aggregations", "comparison", "thresholdValue", "duration", "trigger"],
      aggregation: ["alignmentPeriod", "perSeriesAligner", "crossSeriesReducer", "groupByFields"],
      matched: ["filter", "labelExtractors"],
      strategy: ["notificationRateLimit", "autoClose"],
    };
    const only = (value: Json, keys: string[]) => expect(Object.keys(value).filter((k) => !keys.includes(k))).toEqual([]);
    for (const policy of Object.values(monitoring(options).alerts) as Json[]) {
      only(policy, allowed.policy);
      only(policy.documentation, allowed.documentation);
      if (policy.alertStrategy) only(policy.alertStrategy, allowed.strategy);
      expect(["CRITICAL", "ERROR", "WARNING"]).toContain(policy.severity);
      for (const condition of policy.conditions) {
        only(condition, allowed.condition);
        if (condition.conditionThreshold) {
          only(condition.conditionThreshold, allowed.threshold);
          for (const aggregation of condition.conditionThreshold.aggregations) only(aggregation, allowed.aggregation);
        }
        if (condition.conditionMatchedLog) only(condition.conditionMatchedLog, allowed.matched);
      }
    }
  });
});

// What Google Cloud itself records about the project, in the Admin Activity log: always written, and it cannot be switched
// off. The method names are the ones Google documents for each service. The functions' own entries never match these.
describe("alerts for changes made to the project itself", () => {
  const activity = "projects/my-project-123/logs/cloudaudit.googleapis.com%2Factivity";
  const audit = (serviceName: string, methodName: string, logName = activity): Json => ({
    logName,
    severity: "NOTICE",
    resource: { type: "audited_resource" },
    protoPayload: {
      "@type": "type.googleapis.com/google.cloud.audit.AuditLog",
      serviceName,
      methodName,
      authenticationInfo: { principalEmail: "someone@example.com" },
      requestMetadata: { callerIp: "203.0.113.5" },
    },
  });
  const dataAccess = "projects/my-project-123/logs/cloudaudit.googleapis.com%2Fdata_access";
  const rules = (method: string, log?: string) => audit("firebaserules.googleapis.com", `google.firebase.rules.v1.FirebaseRulesService.${method}`, log);

  // alert -> the entries it must fire on, and the ones it must not
  const cases: Record<string, { fires: Json[]; quiet: Json[] }> = {
    "rules-changed": {
      fires: ["CreateRuleset", "CreateRelease", "UpdateRelease", "DeleteRelease", "DeleteRuleset"].map((method) => rules(method)),
      quiet: [rules("GetRuleset", dataAccess), rules("ListReleases", dataAccess), audit("firebase.googleapis.com", "google.firebase.service.v1beta1.WebAppService.UpdateWebApp")],
    },
    "iam-changed": {
      fires: [
        audit("cloudresourcemanager.googleapis.com", "SetIamPolicy"),
        audit("iam.googleapis.com", "google.iam.admin.v1.SetIAMPolicy"), // a service account's policy: the capital IAM is how Google writes it
        audit("iam.googleapis.com", "google.iam.v1.WorkloadIdentityPools.SetIamPolicy"),
      ],
      quiet: [audit("cloudresourcemanager.googleapis.com", "GetIamPolicy", dataAccess), audit("iam.googleapis.com", "google.iam.admin.v1.CreateServiceAccount")],
    },
    "service-account-key": {
      fires: [audit("iam.googleapis.com", "google.iam.admin.v1.CreateServiceAccountKey"), audit("iam.googleapis.com", "google.iam.admin.v1.UploadServiceAccountKey")],
      quiet: [
        audit("iam.googleapis.com", "google.iam.admin.v1.DeleteServiceAccountKey"),
        audit("iam.googleapis.com", "google.iam.admin.v1.GetServiceAccountKey", dataAccess),
        audit("iam.googleapis.com", "google.iam.admin.v1.CreateServiceAccount"),
      ],
    },
    "firebase-changed": {
      fires: [
        audit("firebase.googleapis.com", "google.firebase.service.v1beta1.WebAppService.UpdateWebApp"),
        audit("firebase.googleapis.com", "google.firebase.service.v1beta1.FirebaseProjectService.UpdateFirebaseProject"),
        audit("apikeys.googleapis.com", "google.api.apikeys.v2.ApiKeys.UpdateKey"), // API keys are not under firebase.googleapis.com
        audit("apikeys.googleapis.com", "google.api.apikeys.v2.ApiKeys.CreateKey"),
      ],
      quiet: [
        audit("firebase.googleapis.com", "google.firebase.service.v1beta1.WebAppService.GetWebApp", dataAccess),
        rules("UpdateRelease"),
        audit("iam.googleapis.com", "google.iam.admin.v1.SetIAMPolicy"),
      ],
    },
  };
  const filterOf = (slug: string, options_ = options) => ((monitoring(options_).alerts[slug] as Json).conditions[0] as Json).conditionMatchedLog.filter as string;

  test("there is one log-based policy for each, alone in its policy, with the rate limit the API requires", () => {
    for (const slug of Object.keys(cases)) {
      const policy = monitoring(options).alerts[slug] as Json;
      expect(policy, slug).toBeDefined();
      expect(policy.conditions).toHaveLength(1);
      expect(policy.conditions[0].conditionMatchedLog).toBeDefined();
      expect(policy.alertStrategy.notificationRateLimit.period).toMatch(/^\d+s$/);
      expect(["ERROR", "WARNING"]).toContain(policy.severity);
    }
  });

  test("each fires on the Admin Activity entries it is for, and on nothing else", () => {
    for (const [slug, { fires, quiet }] of Object.entries(cases)) {
      for (const entry of fires) expect(matches(filterOf(slug), entry), `${slug} fires on ${entry.protoPayload.methodName}`).toBe(true);
      for (const entry of quiet) expect(matches(filterOf(slug), entry), `${slug} stays quiet on ${entry.protoPayload.methodName} in ${entry.logName.split("%2F")[1]}`).toBe(false);
    }
  });

  test("they watch the project, not the functions: --service does not narrow them, and the functions' entries never match", async () => {
    const entries = all(await scenarios()).map((entry) => asLogEntry(entry));
    for (const slug of Object.keys(cases)) {
      expect(filterOf(slug)).not.toContain("cloud_run_revision");
      expect(filterOf(slug, { ...options, services: ["checkout"] } as typeof options)).toBe(filterOf(slug));
      for (const entry of entries) expect(matches(filterOf(slug), entry)).toBe(false);
    }
  });

  test("the function alerts do not fire on them", () => {
    const functionAlerts = Object.entries(monitoring(options).alerts).filter(([slug]) => !(slug in cases));
    for (const [slug, policy] of functionAlerts) {
      for (const condition of (policy as Json).conditions as Json[]) {
        if (!condition.conditionMatchedLog) continue;
        for (const { fires } of Object.values(cases)) for (const entry of fires) expect(matches(condition.conditionMatchedLog.filter, entry), slug).toBe(false);
      }
    }
  });

  test("their documentation says how to see who did it, from the Admin Activity log", () => {
    for (const slug of Object.keys(cases)) {
      const content = (monitoring(options).alerts[slug] as Json).documentation.content as string;
      expect(content, slug).toContain("protoPayload.authenticationInfo.principalEmail");
      expect(content, slug).toContain("cloudaudit.googleapis.com%2Factivity");
    }
  });
});

describe("dashboard", () => {
  const tiles = () => (monitoring(options).dashboard.mosaicLayout.tiles as Json[]);

  test("it is a mosaic of tiles that stay inside the columns and don't overlap", () => {
    const { dashboard } = monitoring(options);
    expect(dashboard.displayName).toBe("resultlog: functions");
    const columns = dashboard.mosaicLayout.columns;
    expect(columns).toBeGreaterThanOrEqual(1);
    expect(columns).toBeLessThanOrEqual(48);
    const t = tiles();
    for (const tile of t) {
      expect(tile.xPos + tile.width).toBeLessThanOrEqual(columns);
      expect(tile.width).toBeGreaterThanOrEqual(1);
      expect(tile.height).toBeGreaterThanOrEqual(1);
    }
    for (const [i, a] of t.entries()) {
      for (const b of t.slice(i + 1)) {
        const apart = a.xPos + a.width <= b.xPos || b.xPos + b.width <= a.xPos || a.yPos + a.height <= b.yPos || b.yPos + b.height <= a.yPos;
        expect(apart).toBe(true);
      }
    }
  });

  test("charts show Cloud Run's own request metrics next to resultlog's, and logs panels list the entries", () => {
    const widgets = tiles().map((t) => t.widget as Json);
    const filters = widgets.flatMap((w) => (w.xyChart?.dataSets ?? []).map((d: Json) => d.timeSeriesQuery.timeSeriesFilter.filter as string));
    expect(filters.some((f) => f.includes('metric.type="run.googleapis.com/request_count"'))).toBe(true);
    expect(filters.some((f) => f.includes('metric.type="run.googleapis.com/request_latencies"'))).toBe(true);
    const own = filters.filter((f) => f.includes("logging.googleapis.com/user/"));
    expect(own.length).toBeGreaterThanOrEqual(5);
    const { metrics } = monitoring(options);
    for (const f of own) {
      const metric = /logging\.googleapis\.com\/user\/([a-z_]+)/.exec(f)?.[1] as string;
      expect(Object.keys(metrics)).toContain(metric);
    }
    const panels = widgets.filter((w) => w.logsPanel);
    expect(panels.length).toBeGreaterThanOrEqual(2);
    expect(panels.every((w) => w.logsPanel.resourceNames[0] === "projects/my-project-123")).toBe(true);
    expect(widgets.some((w) => w.text?.format === "MARKDOWN" && w.text.content.includes("resultlog digest"))).toBe(true);
  });

  test("the logs panels select what a person wants to read", async () => {
    const entries = await scenarios();
    const panels = tiles().map((t) => t.widget).filter((w: Json) => w.logsPanel) as Json[];
    const filters = panels.map((w) => w.logsPanel.filter as string);
    const showsSecurity = filters.find((f) => f.includes("securityEvent"));
    const showsFailures = filters.find((f) => f.includes("severity>="));
    expect(showsSecurity).toBeDefined();
    expect(matches(showsSecurity as string, asLogEntry(entries.security?.[0] as Json))).toBe(true);
    expect(matches(showsSecurity as string, asLogEntry(entries.audit?.[0] as Json))).toBe(true);
    expect(matches(showsSecurity as string, asLogEntry(entries.success?.[0] as Json))).toBe(false);
    expect(showsFailures).toBeDefined();
  });

  test("every key is one the dashboards API defines", () => {
    const allowed = {
      widget: ["title", "xyChart", "text", "logsPanel"],
      chart: ["dataSets", "yAxis"],
      dataSet: ["timeSeriesQuery", "plotType", "legendTemplate", "minAlignmentPeriod"],
      query: ["timeSeriesFilter"],
      filter: ["filter", "aggregation"],
      aggregation: ["alignmentPeriod", "perSeriesAligner", "crossSeriesReducer", "groupByFields"],
    };
    const only = (value: Json, keys: string[]) => expect(Object.keys(value).filter((k) => !keys.includes(k))).toEqual([]);
    for (const tile of tiles()) {
      only(tile, ["xPos", "yPos", "width", "height", "widget"]);
      only(tile.widget, allowed.widget);
      for (const set of tile.widget.xyChart?.dataSets ?? []) {
        only(set, allowed.dataSet);
        only(set.timeSeriesQuery, allowed.query);
        only(set.timeSeriesQuery.timeSeriesFilter, allowed.filter);
        only(set.timeSeriesQuery.timeSeriesFilter.aggregation, allowed.aggregation);
        expect(["LINE", "STACKED_AREA", "STACKED_BAR"]).toContain(set.plotType);
      }
    }
  });

  test("a list of functions narrows the charts and the panels", () => {
    const text = JSON.stringify(monitoring({ ...options, services: ["checkout"] }).dashboard);
    expect(text).toContain('resource.label.service_name=one_of(\\"checkout\\")');
    expect(text).toContain('resource.labels.service_name=(\\"checkout\\")');
  });
});

describe("files and the README", () => {
  const set = files(options);
  const readme = set["README.md"] as string;
  const m = monitoring(options);
  /** The first shell block after a heading. */
  const block = (heading: string) => readme.slice(readme.indexOf(heading)).match(/```bash\n([\s\S]*?)\n```/)?.[1] ?? "";

  test("the file set is complete and every JSON file parses; there is no script that changes Google Cloud", () => {
    expect(Object.keys(set).sort()).toEqual(
      [
        "README.md",
        "dashboard.json",
        ...Object.keys(m.metrics).map((name) => `metrics/${name}.json`),
        ...Object.keys(m.alerts).map((slug) => `alerts/${slug}.json`),
      ].sort(),
    );
    for (const [path, content] of Object.entries(set)) if (path.endsWith(".json")) expect(() => JSON.parse(content)).not.toThrow();
  });

  test("every file the README names exists, and the policy it looks up is one of ours", () => {
    const named = [...readme.matchAll(/\b((?:metrics|alerts)\/[\w-]+\.json|dashboard\.json)\b/g)].map((found) => found[1] as string);
    expect(named.length).toBeGreaterThan(0);
    for (const path of named) expect(set[path]).toBeDefined();
    const [, displayName] = readme.match(/displayName="([^"]+)"/) ?? [];
    expect(Object.values(m.alerts).map((policy) => policy.displayName)).toContain(displayName);
    expect(readme).toContain("--validate-only");
  });

  test("it tells the reader that four alerts watch the project itself, and that they fire on their own work too", () => {
    expect(readme).toContain("Admin Activity");
    expect(readme).toContain("whole project");
    expect(readme).toMatch(/your own (deploys|changes|work)/);
  });

  test("the commands apply the metrics, then the policies, then the dashboard, to the project", () => {
    // A stand-in for gcloud that records every call, so that what the README tells people to run is run here.
    const work = mkdtempSync(join(tmpdir(), "resultlog-monitoring-"));
    const log = join(work, "gcloud.log");
    mkdirSync(join(work, "bin"));
    writeFileSync(join(work, "bin", "gcloud"), `#!/bin/sh\necho "$@" >> '${log}'\n`);
    chmodSync(join(work, "bin", "gcloud"), 0o755);
    const dir = join(work, "out");
    for (const [path, content] of Object.entries(set)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const run = spawnSync("bash", ["-e", "-c", block("## Apply")], {
      cwd: dir,
      env: { PATH: `${join(work, "bin")}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      ...Object.keys(m.metrics)
        .sort()
        .map((name) => `logging metrics create ${name} --config-from-file metrics/${name}.json --project my-project-123`),
      ...Object.keys(m.alerts)
        .sort()
        .map((slug) => `monitoring policies create --policy-from-file alerts/${slug}.json --project my-project-123`),
      "monitoring dashboards create --config-from-file dashboard.json --project my-project-123",
    ]);
  });
});

describe("the console recipes in the README", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("### By hand, in the console"), readme.indexOf("### Or have the files written for you"));
  const recipes = (section.match(/```text\n([\s\S]*?)\n```/)?.[1] ?? "").split("\n\n").map((chunk) => {
    const [title = "", filter = ""] = chunk.split("\n");
    return { title: title.replace(/^# /, ""), filter };
  });

  // What each recipe is for, by a part of its filter: the scenarios whose entries it must match, and no others.
  const meant: [needle: string, scenarios: string[]][] = [
    // The interrupted stream throws inside its handler, so that invocation is a server failure as well.
    ["severity>=ERROR", ["error", "timeout", "llm-interrupted"]],
    ["httpRequest.status>=500", ["error", "timeout", "llm-interrupted"]],
    ["authn_token_reuse", ["replay"]],
    ["auditEvent", ["audit"]],
    ["DeadlineExceeded", ["timeout"]],
    ["jsonPayload.llm", ["llm-truncated", "llm-blocked", "llm-interrupted"]],
  ];

  // The recipes about the project itself (Google's Admin Activity entries, not the functions') are the generated alerts' filters.
  const aboutTheProject = recipes.filter(({ filter }) => filter.startsWith("logName:"));
  const aboutFunctions = recipes.filter(({ filter }) => !filter.startsWith("logName:"));

  test("the recipes about the project itself are the generated alerts' filters, word for word", () => {
    const generated = ["rules-changed", "iam-changed", "service-account-key", "firebase-changed"].map(
      (slug) => ((monitoring(options).alerts[slug] as Json).conditions[0] as Json).conditionMatchedLog.filter as string,
    );
    expect(aboutTheProject.map(({ filter }) => filter)).toEqual(generated);
  });

  test("each one matches the entries it is meant for, and no others", async () => {
    const made = await scenarios();
    expect(aboutFunctions).toHaveLength(meant.length); // a new recipe needs its line above
    for (const { title, filter } of aboutFunctions) {
      const expected = meant.find(([needle]) => filter.includes(needle))?.[1];
      expect(expected, title).toBeDefined();
      for (const [name, entries] of Object.entries(made)) {
        expect(entries.some((entry) => matches(filter, asLogEntry(entry))), `${title} / ${name}`).toBe((expected ?? []).includes(name));
      }
    }
  });

  test("the Japanese README gives the same filters", () => {
    const ja = readFileSync(join(import.meta.dir, "..", "README.ja.md"), "utf8");
    const filtersOf = (text: string) => (text.match(/```text\n([\s\S]*?)\n```/)?.[1] ?? "").split("\n").filter((line) => line && !line.startsWith("# "));
    const jaSection = ja.slice(ja.indexOf("### コンソールで手作業で"), ja.indexOf("### ファイルとして書き出す"));
    expect(filtersOf(jaSection)).toEqual(filtersOf(section));
    expect(filtersOf(section)).toHaveLength(recipes.length);
  });
});

describe("the resultlog monitoring command", () => {
  test("writes the files, and points at the README for what to run", () => {
    const out = mkdtempSync(join(tmpdir(), "resultlog-cli-"));
    const run = spawnSync(
      "bun",
      [join(import.meta.dir, "cli.ts"), "monitoring", "--project", "my-project-123", "--out", out, "--service", "checkout,on-order", "--threshold", "errors=9"],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(existsSync(join(out, "README.md"))).toBe(true);
    expect(existsSync(join(out, "apply.sh"))).toBe(false);
    expect(readdirSync(join(out, "metrics")).length).toBe(9);
    expect(readFileSync(join(out, "alerts", "server-errors.json"), "utf8")).toContain('"thresholdValue": 9');
    expect(run.stdout).toContain("Nothing was sent to Google Cloud");
    expect(run.stdout).toContain(join(out, "README.md"));
  });

  test("a missing or bad project is reported, not written", () => {
    const out = mkdtempSync(join(tmpdir(), "resultlog-cli-"));
    expect(spawnSync("bun", [join(import.meta.dir, "cli.ts"), "monitoring", "--out", out], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync("bun", [join(import.meta.dir, "cli.ts"), "monitoring", "--project", "BAD; id", "--out", out], { encoding: "utf8" }).status).toBe(2);
    expect(readdirSync(out)).toEqual([]);
  });
});
