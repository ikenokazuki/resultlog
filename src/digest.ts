import { createHash, randomBytes } from "node:crypto";

export interface DigestOptions {
  /** How many failure groups, hosts, actors and audit events to list. Default 10. */
  top?: number;
  /** The Markdown never exceeds this many characters: what ranks lowest is dropped. Default 20,000. */
  maxChars?: number;
  /** Replaces uids, IP addresses and user agents with stable pseudonyms, for pasting into an outside AI service. */
  pseudonymize?: boolean;
  /** Uids that may change permissions and accounts: a change by anyone else becomes a high finding. */
  admins?: string[];
  /** Overrides the threshold of a rule by name, e.g. `{ "authz-probing": 5 }`. */
  thresholds?: Record<string, number>;
  /** Rules of your own, evaluated with the built-in ones. */
  rules?: Rule[];
}

/** One log entry as a rule sees it. With the pseudonymizer on, `uid`, `ip` and `userAgent` are already pseudonyms. */
export interface Probe {
  /** A security event, an audit event, a failed invocation or an ordinary one. */
  kind: "security" | "audit" | "failure" | "success";
  /** The security or audit event, when the entry is one. */
  event?: string;
  uid?: string;
  ip?: string;
  userAgent?: string;
  service: string;
  time?: number;
  timeText?: string;
  /** True when `uid` is one of the `admins` given to `digest`. */
  admin: boolean;
  /** The entry as logged. */
  fields: Record<string, any>;
}

/**
 * A detection, in the shape fail2ban and CrowdSec use: the entries that count (`filter`), counted per `key` (an
 * address, an account), either as entries or as distinct values of `distinct` (accounts per address), and reported
 * when `threshold` is reached within `windowMs`. A rule needs no knowledge of any attack: only of the fields.
 */
export interface Rule {
  name: string;
  severity: "info" | "low" | "medium" | "high";
  summary: string;
  /** What to do next. */
  hint: string;
  filter(probe: Probe): boolean;
  /** Entries without a key are ignored. */
  key(probe: Probe): string | undefined;
  distinct?(probe: Probe): string | undefined;
  threshold: number;
  /** Without one, the whole log is the window. Entries without a time are counted over the whole log as well. */
  windowMs?: number;
}

export interface Finding {
  rule: string;
  severity: Rule["severity"];
  subject: string;
  count: number;
  first?: string;
  last?: string;
  window?: string;
  /** The distinct values, when the rule counts them. */
  evidence?: string;
  summary: string;
  hint: string;
}

export interface Digest {
  window?: { from: string; to: string };
  /** The resultlog entries read. */
  entries: number;
  /** Invocations, with sampled successes counted at their weight. */
  invocations: number;
  severities: Record<string, number>;
  /** What the rules found, most serious first. */
  findings: Finding[];
  services: {
    name: string;
    invocations: number;
    failures: number;
    failureRate: number;
    p50Ms?: number;
    p95Ms?: number;
    coldStarts: number;
  }[];
  failures: {
    fingerprint: string;
    name: string;
    code?: string;
    severity: string;
    count: number;
    services: string[];
    first?: string;
    last?: string;
    retryable?: boolean;
    message: string;
    breadcrumbs: string[];
    upstream: Record<string, string>;
    trace?: string;
    sample: Record<string, unknown>;
  }[];
  security: {
    events: Record<string, number>;
    actors: { who: string; count: number; events: string[] }[];
    peak?: { minute: string; count: number };
    audit: { time?: string; event: string; actor?: string; ip?: string; details: Record<string, unknown> }[];
  };
  external: {
    host: string;
    calls: number;
    failed: number;
    failureRate: number;
    statuses: Record<string, number>;
    avgMs: number;
    maxMs: number;
  }[];
  llm?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost?: number;
    models: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
    truncated: number;
    blocked: number;
    interrupted: number;
    unrecognized: number;
  };
  reliability: {
    timeouts: number;
    duplicates: number;
    handledErrors: number;
    retries: Record<string, number>;
    coldStarts: number;
  };
}

type Fields = Record<string, any>;

interface Entry {
  fields: Fields;
  severity: string;
  service: string;
  time?: number;
  timeText?: string;
  trace?: string;
  /** A sampled success stands for 1 / sampleRate invocations. */
  weight: number;
}

const SEVERITIES = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];
const severityRank = (severity: string) => Math.max(0, SEVERITIES.indexOf(severity));
// What an audit entry carries besides its own details.
const NOT_DETAILS = new Set(["severity", "message", "auditEvent", "actor", "authUid", "durationMs", "external", "llm", "breadcrumbs"]);

/** Reads a JSON array, or one JSON value per line (what `gcloud logging read` and a log export produce). */
export function parseLogs(text: string): { logs: unknown[]; skipped: number } {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      return { logs: JSON.parse(trimmed) as unknown[], skipped: 0 };
    } catch {} // fall through: maybe one value per line that happens to start with "["
  }
  const logs: unknown[] = [];
  let skipped = 0;
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      logs.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  return { logs, skipped };
}

/** Accepts a Cloud Logging LogEntry (our fields under `jsonPayload`) and a plain entry alike. */
function normalize(raw: unknown): Entry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const log = raw as Fields;
  const fields: Fields = typeof log.jsonPayload === "object" && log.jsonPayload !== null ? { ...log.jsonPayload } : { ...log };
  const ours = typeof fields.durationMs === "number" || typeof fields.auditEvent === "string" || typeof fields.securityEvent === "string";
  if (!ours) return undefined;
  const timeText: unknown = log.timestamp ?? fields.timestamp ?? fields.time;
  const time = typeof timeText === "string" ? Date.parse(timeText) : Number.NaN;
  const labels = log.resource?.labels ?? {};
  return {
    fields,
    severity: String(log.severity ?? fields.severity ?? "DEFAULT").toUpperCase(),
    service: String(labels.service_name ?? labels.function_name ?? fields.service ?? "(unknown)"),
    time: Number.isFinite(time) ? time : undefined,
    timeText: Number.isFinite(time) ? (timeText as string) : undefined,
    trace: log.trace ?? fields["logging.googleapis.com/trace"] ?? fields.trace,
    weight: typeof fields.sampleRate === "number" && fields.sampleRate > 0 ? 1 / fields.sampleRate : 1,
  };
}

function percentile(values: [value: number, weight: number][], p: number): number | undefined {
  const total = values.reduce((sum, [, weight]) => sum + weight, 0);
  let seen = 0;
  for (const [value, weight] of [...values].sort((a, b) => a[0] - b[0])) {
    seen += weight;
    if (seen >= p * total) return value;
  }
  return undefined;
}

const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);
const minuteOf = (time: number) => `${new Date(time).toISOString().slice(0, 16)}:00Z`;
const firstLine = (text: unknown) => String(text ?? "").split("\n")[0] ?? "";
/** The shape of a message, so that "timeout after 120 ms for order 5512" and "... 90 ms for order 77" are one kind. */
const shapeOf = (text: string) => text.replace(/\b[0-9a-f]{8,}\b/gi, "?").replace(/\d+/g, "#");

/** An HTTP status as a short class: "5xx", but 429 and 408 on their own, since they mean something specific. */
function statusClass(status: string): string {
  return status === "429" || status === "408" ? status : `${status[0]}xx`;
}

function pseudonymizer(enabled: boolean) {
  const salt = randomBytes(8).toString("hex"); // per run: pseudonyms can't be compared across digests
  return (kind: "user" | "ip" | "ua", value: unknown): string => {
    const text = value === undefined || value === null ? "" : String(value);
    if (!enabled || text === "") return text;
    return `${kind}_${createHash("sha256").update(`${salt}${kind}${text}`).digest("hex").slice(0, 6)}`;
  };
}

type Who = ReturnType<typeof pseudonymizer>;

/** A copy small enough to paste: a few lines of stack, a few breadcrumbs, short strings. */
function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const text = value.split("\n").slice(0, 8).join("\n");
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  if (Array.isArray(value)) return value.slice(-5).map((v) => shrink(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    if (depth > 4) return "…";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, depth + 1)]));
  }
  return value;
}

function sampleOf(entry: Entry, who: Who): Record<string, unknown> {
  const sample = shrink({ severity: entry.severity, ...entry.fields }) as Fields;
  if (typeof sample.authUid === "string") sample.authUid = who("user", entry.fields.authUid);
  if (typeof sample.actor === "object" && sample.actor !== null) {
    const actor = entry.fields.actor ?? {};
    const named: Record<string, string> = { uid: "user", ip: "ip", forwardedFor: "ip", userAgent: "ua" };
    sample.actor = Object.fromEntries(
      Object.entries(sample.actor as Fields).map(([k, v]) => [k, named[k] ? who(named[k] as "user" | "ip" | "ua", actor[k]) : v]),
    );
  }
  return sample;
}

export function digest(logs: unknown[], options: DigestOptions = {}): { data: Digest; markdown: string } {
  const { top = 10, maxChars = 20_000, pseudonymize = false, admins, thresholds = {}, rules = [] } = options;
  const who = pseudonymizer(pseudonymize);
  const entries = logs.map(normalize).filter((entry): entry is Entry => entry !== undefined);
  const invocations = entries.filter((e) => typeof e.fields.durationMs === "number");
  const failed = invocations.filter((e) => typeof e.fields.errorName === "string");

  // overview
  const times = entries.filter((e) => e.time !== undefined);
  const first = times.reduce<Entry | undefined>((a, e) => (a && (a.time as number) <= (e.time as number) ? a : e), undefined);
  const last = times.reduce<Entry | undefined>((a, e) => (a && (a.time as number) >= (e.time as number) ? a : e), undefined);
  const severities: Record<string, number> = {};
  for (const e of entries) severities[e.severity] = (severities[e.severity] ?? 0) + 1;

  // services
  const byService = new Map<string, Entry[]>();
  for (const e of invocations) byService.set(e.service, [...(byService.get(e.service) ?? []), e]);
  const services = [...byService]
    .map(([name, list]) => {
      const total = sum(list.map((e) => e.weight));
      const failures = list.filter((e) => typeof e.fields.errorName === "string").length;
      const durations = list.map((e): [number, number] => [e.fields.durationMs, e.weight]);
      return {
        name,
        invocations: Math.round(total),
        failures,
        failureRate: failures / total,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        coldStarts: list.filter((e) => e.fields.coldStart === true).length,
      };
    })
    .sort((a, b) => b.invocations - a.invocations);

  // failure groups
  const groups = new Map<string, Entry[]>();
  for (const e of failed) {
    const f = e.fields;
    const key = typeof f.fingerprint === "string" ? f.fingerprint : `~${createHash("sha1").update(`${f.errorName}|${f.errorCode}|${shapeOf(firstLine(f.message))}`).digest("hex").slice(0, 11)}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const failures = [...groups]
    .map(([fingerprint, list]) => {
      const head = list[0] as Entry;
      const timed = list.filter((e) => e.time !== undefined);
      const early = timed.reduce<Entry | undefined>((a, e) => (a && (a.time as number) <= (e.time as number) ? a : e), undefined);
      const late = timed.reduce<Entry | undefined>((a, e) => (a && (a.time as number) >= (e.time as number) ? a : e), undefined);
      const upstream: Record<string, Record<string, number>> = {};
      for (const e of list) {
        for (const [host, stats] of Object.entries((e.fields.external ?? {}) as Record<string, Fields>)) {
          const counts = (upstream[host] ??= {});
          for (const [status, n] of Object.entries((stats.statuses ?? {}) as Record<string, number>)) {
            if (Number(status) >= 400) counts[statusClass(status)] = (counts[statusClass(status)] ?? 0) + n;
          }
          if (stats.errors) counts.error = (counts.error ?? 0) + stats.errors;
          if (stats.pending) counts.pending = (counts.pending ?? 0) + stats.pending;
        }
      }
      return {
        fingerprint,
        name: String(head.fields.errorName),
        code: head.fields.errorCode as string | undefined,
        severity: list.map((e) => e.severity).reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a)),
        count: list.length,
        services: [...new Set(list.map((e) => e.service).filter((s) => s !== "(unknown)"))].sort(),
        first: early?.timeText,
        last: late?.timeText,
        retryable: head.fields.retryable as boolean | undefined,
        message: firstLine(head.fields.message),
        breadcrumbs: ((head.fields.breadcrumbs ?? []) as Fields[]).slice(-5).map((c) => String(c.message)),
        upstream: Object.fromEntries(
          Object.entries(upstream)
            .filter(([, counts]) => Object.keys(counts).length > 0)
            .map(([host, counts]) => [host, Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(", ")]),
        ),
        trace: head.trace,
        sample: sampleOf(head, who),
      };
    })
    .sort((a, b) => b.count - a.count || severityRank(b.severity) - severityRank(a.severity))
    .slice(0, top);

  // security and audit
  const secured = entries.filter((e) => typeof e.fields.securityEvent === "string");
  const events: Record<string, number> = {};
  const actors = new Map<string, { who: string; count: number; events: Set<string> }>();
  const perMinute = new Map<string, number>();
  for (const e of secured) {
    const event = e.fields.securityEvent as string;
    events[event] = (events[event] ?? 0) + 1;
    const actor = (e.fields.actor ?? {}) as Fields;
    const label = [
      actor.uid ? `uid=${who("user", actor.uid)}` : undefined,
      actor.ip ? `ip=${who("ip", actor.ip)}` : undefined,
      actor.userAgent ? `ua=${who("ua", actor.userAgent)}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const seen = actors.get(label) ?? { who: label || "(unknown)", count: 0, events: new Set<string>() };
    seen.count++;
    seen.events.add(event);
    actors.set(label, seen);
    if (e.time !== undefined) perMinute.set(minuteOf(e.time), (perMinute.get(minuteOf(e.time)) ?? 0) + 1);
  }
  const peak = [...perMinute].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const audit = entries
    .filter((e) => typeof e.fields.auditEvent === "string")
    .slice(0, top)
    .map((e) => ({
      time: e.timeText,
      event: e.fields.auditEvent as string,
      actor: who("user", e.fields.actor?.uid ?? e.fields.authUid) || undefined,
      ip: who("ip", e.fields.actor?.ip) || undefined,
      details: Object.fromEntries(
        Object.entries(e.fields).filter(([k, v]) => !NOT_DETAILS.has(k) && !k.includes("/") && ["string", "number", "boolean"].includes(typeof v)),
      ),
    }));

  // outgoing calls, weighted
  const hosts = new Map<string, { calls: number; failed: number; statuses: Record<string, number>; totalMs: number; maxMs: number }>();
  for (const e of invocations) {
    for (const [host, stats] of Object.entries((e.fields.external ?? {}) as Record<string, Fields>)) {
      const h = hosts.get(host) ?? { calls: 0, failed: 0, statuses: {}, totalMs: 0, maxMs: 0 };
      h.calls += stats.calls * e.weight;
      h.totalMs += stats.totalMs * e.weight;
      h.maxMs = Math.max(h.maxMs, stats.maxMs);
      for (const [status, n] of Object.entries((stats.statuses ?? {}) as Record<string, number>)) {
        h.statuses[status] = (h.statuses[status] ?? 0) + n * e.weight;
        if (Number(status) >= 400) h.failed += n * e.weight;
      }
      h.failed += ((stats.errors ?? 0) + (stats.pending ?? 0)) * e.weight;
      hosts.set(host, h);
    }
  }
  const external = [...hosts]
    .map(([host, h]) => ({
      host,
      calls: Math.round(h.calls),
      failed: Math.round(h.failed),
      failureRate: h.failed / h.calls,
      statuses: Object.fromEntries(Object.entries(h.statuses).map(([k, n]) => [k, Math.round(n)])),
      avgMs: Math.round(h.totalMs / h.calls),
      maxMs: h.maxMs,
    }))
    .sort((a, b) => b.failureRate - a.failureRate || b.calls - a.calls)
    .slice(0, top);

  // LLM calls, weighted
  const withLlm = invocations.filter((e) => typeof e.fields.llm === "object" && e.fields.llm !== null);
  let llm: Digest["llm"];
  if (withLlm.length > 0) {
    llm = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, models: {}, truncated: 0, blocked: 0, interrupted: 0, unrecognized: 0 };
    for (const e of withLlm) {
      const l = e.fields.llm as Fields;
      const w = e.weight;
      llm.calls += (l.calls ?? 0) * w;
      llm.inputTokens += (l.inputTokens ?? 0) * w;
      llm.outputTokens += (l.outputTokens ?? 0) * w;
      llm.cachedTokens += (l.cachedTokens ?? 0) * w;
      for (const flag of ["truncated", "blocked", "interrupted", "unrecognized"] as const) llm[flag] += (l[flag] ?? 0) * w;
      if (typeof l.cost === "number") llm.cost = Math.round(((llm.cost ?? 0) + l.cost * w) * 1e9) / 1e9;
      for (const [model, m] of Object.entries((l.models ?? {}) as Record<string, Fields>)) {
        const into = (llm.models[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
        into.calls += (m.calls ?? 0) * w;
        into.inputTokens += (m.inputTokens ?? 0) * w;
        into.outputTokens += (m.outputTokens ?? 0) * w;
      }
    }
  }

  // reliability
  const retries: Record<string, number> = {};
  for (const e of invocations) {
    for (const r of (e.fields.retries ?? []) as Fields[]) {
      const key = typeof r.stoppedBy === "string" ? r.stoppedBy : r.outcome === "ok" ? "recovered" : "gave-up";
      retries[key] = (retries[key] ?? 0) + 1;
    }
  }
  const reliability = {
    timeouts: failed.filter((e) => e.fields.errorName === "DeadlineExceeded").length,
    duplicates: invocations.filter((e) => e.fields.duplicate === true).length,
    handledErrors: sum(invocations.map((e) => (Array.isArray(e.fields.handledErrors) ? e.fields.handledErrors.length : 0))),
    retries,
    coldStarts: invocations.filter((e) => e.fields.coldStart === true).length,
  };

  // findings
  const adminUids = new Set(admins ?? []);
  const probes = entries.map((e): Probe => {
    const f = e.fields;
    const actor = (f.actor ?? {}) as Fields;
    const uid = actor.uid ?? f.authUid;
    const text = (kind: "user" | "ip" | "ua", value: unknown) => who(kind, value) || undefined;
    return {
      kind: typeof f.securityEvent === "string" ? "security" : typeof f.auditEvent === "string" ? "audit" : typeof f.errorName === "string" ? "failure" : "success",
      event: (f.securityEvent ?? f.auditEvent) as string | undefined,
      uid: text("user", uid),
      ip: text("ip", actor.ip),
      userAgent: text("ua", actor.userAgent),
      service: e.service,
      time: e.time,
      timeText: e.timeText,
      admin: typeof uid === "string" && adminUids.has(uid),
      fields: f,
    };
  });
  const findings = [...defaultRules(admins !== undefined), ...rules]
    .map((rule) => (rule.name in thresholds ? { ...rule, threshold: thresholds[rule.name] as number } : rule))
    .flatMap((rule) => evaluate(rule, probes))
    .sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) || b.count - a.count)
    .slice(0, top);

  const data: Digest = {
    window: first?.timeText && last?.timeText ? { from: first.timeText, to: last.timeText } : undefined,
    entries: entries.length,
    invocations: Math.round(sum(invocations.map((e) => e.weight))),
    severities,
    findings,
    services,
    failures,
    security: {
      events,
      actors: [...actors.values()].sort((a, b) => b.count - a.count).slice(0, top).map((a) => ({ ...a, events: [...a.events] })),
      peak: peak ? { minute: peak[0], count: peak[1] } : undefined,
      audit,
    },
    external,
    llm: llm && {
      ...llm,
      calls: Math.round(llm.calls),
      inputTokens: Math.round(llm.inputTokens),
      outputTokens: Math.round(llm.outputTokens),
      cachedTokens: Math.round(llm.cachedTokens),
    },
    reliability,
  };
  return { data, markdown: entries.length === 0 ? "# resultlog digest\n\nNo resultlog entries found.\n" : render(data, maxChars) };
}

// ---- Rules --------------------------------------------------------------------------

const SEVERITY_ORDER = ["info", "low", "medium", "high"];
const actorLabel = (p: Probe) => [p.uid && `uid=${p.uid}`, p.ip && `ip=${p.ip}`].filter(Boolean).join(" ") || undefined;
// OWASP Logging Vocabulary: changes to permissions and accounts.
const PRIVILEGED = /^(authz_(change|admin)|privilege_|user_(created|updated|archived|deleted))/;
const MINUTE = 60_000;

function defaultRules(withAdmins: boolean): Rule[] {
  const change = (p: Probe) => p.kind === "audit" && PRIVILEGED.test(p.event ?? "");
  const changeKey = (p: Probe) => `${p.event} by ${actorLabel(p) ?? "unknown"}`;
  const rules: Rule[] = [
    {
      name: "authz-probing",
      severity: "medium",
      summary: "One actor was refused access again and again.",
      hint: "Someone is trying resources that are not theirs, or a client is broken. Look at the actor's other calls, check the ownership checks of the functions involved, and consider revoking the account's sessions (revokeRefreshTokens).",
      filter: (p) => p.event === "authz_fail",
      key: actorLabel,
      threshold: 10,
      windowMs: 5 * MINUTE,
    },
    {
      name: "validation-fuzzing",
      severity: "medium",
      summary: "One actor sent malformed input in bulk.",
      hint: "Probing for a weak spot, or a broken client. Compare with the client's releases and read the issues in the entries.",
      filter: (p) => p.event === "input_validation_fail",
      key: actorLabel,
      threshold: 20,
      windowMs: 5 * MINUTE,
    },
    {
      name: "many-accounts-one-ip",
      severity: "medium",
      summary: "One address was seen with several accounts.",
      hint: "Credential stuffing, password spraying or an account farm, or an office or a mobile network behind one address. Compare the accounts' history. If you block, block for a short time (15 minutes or less) rather than for long.",
      filter: (p) => p.uid !== undefined && p.ip !== undefined,
      key: (p) => p.ip && `ip=${p.ip}`,
      distinct: (p) => p.uid,
      threshold: 5,
      windowMs: 60 * MINUTE,
    },
    {
      name: "many-ips-one-account",
      severity: "medium",
      summary: "One account was seen from several addresses.",
      hint: "Shared credentials or a takeover, or a user moving between networks. Look at the sign-in methods and the App Check state; revoking the account's sessions forces a fresh sign-in.",
      filter: (p) => p.uid !== undefined && p.ip !== undefined,
      key: (p) => p.uid && `uid=${p.uid}`,
      distinct: (p) => p.ip,
      threshold: 4,
      windowMs: 60 * MINUTE,
    },
    {
      name: "mass-access",
      severity: "high",
      summary: "One account read sensitive data in bulk.",
      hint: "Scraping or exfiltration with a valid account. Check what was read, put a limit on the endpoint, and consider disabling the account.",
      filter: (p) => p.event?.startsWith("sensitive_read") === true,
      key: (p) => p.uid && `uid=${p.uid}`,
      threshold: 100,
      windowMs: 10 * MINUTE,
    },
    {
      name: "token-reuse",
      severity: "high",
      summary: "An App Check token was used again.",
      hint: "A replayed request. Turn on replay protection (consumeAppCheckToken) for the endpoint and refuse requests whose token was already consumed.",
      filter: (p) => p.event === "authn_token_reuse",
      key: (p) => actorLabel(p) ?? "unknown",
      threshold: 1,
    },
    {
      name: "privilege-change",
      severity: "info",
      summary: "Permissions or accounts were changed.",
      hint: "Check that each change was meant.",
      filter: change,
      key: changeKey,
      threshold: 1,
    },
  ];
  if (withAdmins) {
    rules.push({
      name: "privilege-change-by-non-admin",
      severity: "high",
      summary: "Someone who is not an admin changed permissions or accounts.",
      hint: "Find out how this account got the right to do it. Revert the change and revoke the account's sessions if it was not meant.",
      filter: (p) => change(p) && !p.admin,
      key: changeKey,
      threshold: 1,
    });
  }
  return rules;
}

/** The densest stretch of `rule.windowMs`: how many entries (or distinct values) it holds, and from when to when. */
function busiest(rule: Rule, list: Probe[]) {
  const timed = list.every((p) => p.time !== undefined);
  const ordered = timed ? [...list].sort((a, b) => (a.time as number) - (b.time as number)) : list;
  const items = ordered
    .map((probe, index) => ({ probe, token: rule.distinct ? rule.distinct(probe) : String(index) }))
    .filter((item): item is { probe: Probe; token: string } => item.token !== undefined);
  const inWindow = new Map<string, number>();
  let best = { count: 0, first: undefined as string | undefined, last: undefined as string | undefined, values: [] as string[] };
  let lo = 0;
  for (let hi = 0; hi < items.length; hi++) {
    const added = (items[hi] as { token: string }).token;
    inWindow.set(added, (inWindow.get(added) ?? 0) + 1);
    while (timed && rule.windowMs !== undefined && ((items[hi] as { probe: Probe }).probe.time as number) - ((items[lo] as { probe: Probe }).probe.time as number) > rule.windowMs) {
      const gone = (items[lo] as { token: string }).token;
      const left = (inWindow.get(gone) ?? 1) - 1;
      if (left === 0) inWindow.delete(gone);
      else inWindow.set(gone, left);
      lo++;
    }
    if (inWindow.size > best.count) {
      best = { count: inWindow.size, first: items[lo]?.probe.timeText, last: items[hi]?.probe.timeText, values: rule.distinct ? [...inWindow.keys()] : [] };
    }
  }
  return best;
}

function evaluate(rule: Rule, probes: Probe[]): Finding[] {
  const groups = new Map<string, Probe[]>();
  for (const probe of probes) {
    if (!rule.filter(probe)) continue;
    const key = rule.key(probe);
    if (key !== undefined && key !== "") groups.set(key, [...(groups.get(key) ?? []), probe]);
  }
  const found: Finding[] = [];
  for (const [subject, list] of groups) {
    const best = busiest(rule, list);
    if (best.count < rule.threshold) continue;
    found.push({
      rule: rule.name,
      severity: rule.severity,
      subject,
      count: best.count,
      first: best.first,
      last: best.last,
      window: rule.windowMs === undefined ? undefined : `${rule.windowMs / MINUTE} min`,
      evidence: best.values.length > 0 ? `${best.values.slice(0, 5).join(", ")}${best.values.length > 5 ? `, … (${best.values.length} in all)` : ""}` : undefined,
      summary: rule.summary,
      hint: rule.hint,
    });
  }
  return found;
}

// ---- Markdown ---------------------------------------------------------------------

interface Section {
  title: string;
  blocks: string[];
}

const percent = (rate: number) => `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`;
const clock = (time?: string) => time?.slice(11, 16) ?? "";

function sections(d: Digest): Section[] {
  const findings = d.findings.map(
    (f) =>
      `[${f.severity.toUpperCase()}] ${f.rule} · ${f.subject} · ${f.count}${f.window ? ` within ${f.window}` : ""}${f.first ? ` (${clock(f.first)} → ${clock(f.last)})` : ""}\n   ${f.summary}${f.evidence ? `\n   seen: ${f.evidence}` : ""}\n   next: ${f.hint}`,
  );
  const failures = d.failures.map((g, i) =>
    [
      `${i + 1}. ${g.severity} ${g.name}${g.code ? `/${g.code}` : ""} ×${g.count}${g.services.length ? ` · ${g.services.join(", ")}` : ""}${g.first ? ` · ${clock(g.first)} → ${clock(g.last)}` : ""}${g.retryable === undefined ? "" : g.retryable ? " · retryable" : " · not retryable"} · id ${g.fingerprint}`,
      `   message: ${g.message}`,
      ...(Object.keys(g.upstream).length ? [`   upstream: ${Object.entries(g.upstream).map(([h, s]) => `${h} ${s}`).join("; ")}`] : []),
      ...(g.breadcrumbs.length ? [`   crumbs: ${g.breadcrumbs.join(" → ")}`] : []),
      ...(g.trace ? [`   trace: ${g.trace}`] : []),
    ].join("\n"),
  );
  const security = [
    ...(Object.keys(d.security.events).length ? [`events: ${Object.entries(d.security.events).map(([e, n]) => `${e}×${n}`).join(", ")}${d.security.peak ? ` · busiest minute ${d.security.peak.minute} (${d.security.peak.count})` : ""}`] : []),
    ...d.security.actors.map((a) => `${a.who}: ${a.count}× (${a.events.join(", ")})`),
    ...d.security.audit.map((a) => `audit ${clock(a.time)} ${a.event}${a.actor ? ` by ${a.actor}` : ""}${a.ip ? ` from ${a.ip}` : ""} ${JSON.stringify(a.details)}`),
  ];
  const external = d.external.map(
    (h) => `${h.host}: ${h.calls} calls, ${h.failed} failed (${percent(h.failureRate)}), avg ${h.avgMs} ms, max ${h.maxMs} ms, ${Object.entries(h.statuses).map(([s, n]) => `${s}×${n}`).join(" ")}`,
  );
  const llm = d.llm
    ? [
        `${d.llm.calls} calls, ${d.llm.inputTokens} in / ${d.llm.outputTokens} out tokens (${d.llm.cachedTokens} cached)${d.llm.cost === undefined ? "" : `, cost ${d.llm.cost}`}`,
        ...Object.entries(d.llm.models).map(([m, s]) => `${m}: ${s.calls} calls, ${s.inputTokens} in / ${s.outputTokens} out`),
        ...(d.llm.truncated + d.llm.blocked + d.llm.interrupted + d.llm.unrecognized > 0
          ? [`cut off ${d.llm.truncated}, withheld ${d.llm.blocked}, interrupted ${d.llm.interrupted}, unrecognized ${d.llm.unrecognized}`]
          : []),
      ]
    : [];
  const r = d.reliability;
  const reliability = [
    `timeouts ${r.timeouts} · duplicate events ${r.duplicates} · handled errors ${r.handledErrors} · cold starts ${r.coldStarts}`,
    ...(Object.keys(r.retries).length ? [`retries: ${Object.entries(r.retries).map(([k, n]) => `${k}×${n}`).join(", ")}`] : []),
  ];
  const servicesList = d.services.map(
    (s) => `${s.name}: ${s.invocations} invocations, ${s.failures} failed (${percent(s.failureRate)}), p50 ${s.p50Ms ?? "?"} ms, p95 ${s.p95Ms ?? "?"} ms${s.coldStarts ? `, ${s.coldStarts} cold starts` : ""}`,
  );
  const samples = d.failures.map((g) => `${g.fingerprint}:\n\`\`\`json\n${JSON.stringify(g.sample, null, 1)}\n\`\`\``);
  return [
    { title: "Findings", blocks: findings },
    { title: "Failure groups", blocks: failures },
    { title: "Security and audit", blocks: security },
    { title: "Outgoing calls", blocks: external },
    { title: "LLM calls", blocks: llm },
    { title: "Reliability", blocks: reliability },
    { title: "Services", blocks: servicesList },
    { title: "Samples", blocks: samples },
  ].filter((s) => s.blocks.length > 0);
}

function render(d: Digest, maxChars: number): string {
  const head = [
    "# resultlog digest",
    `${d.window ? `window: ${d.window.from} → ${d.window.to} · ` : ""}${d.entries} entries · ~${d.invocations} invocations (sampling-adjusted)`,
    `severity: ${Object.entries(d.severities).map(([s, n]) => `${s} ${n}`).join(" · ")}`,
    ...(d.findings.length ? [`findings: ${d.findings.length} (${["high", "medium", "low", "info"].map((s) => [s, d.findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(", ")})`] : []),
  ].join("\n");
  const all = sections(d);
  const taken = all.map(() => 0);
  const compose = () =>
    [head, ...all.flatMap((s, i) => (taken[i] ? [`## ${s.title}\n${s.blocks.slice(0, taken[i]).join("\n")}`] : []))].join("\n\n");
  const omitted = () => all.reduce((n, s, i) => n + s.blocks.length - (taken[i] ?? 0), 0);
  const note = () => (omitted() > 0 ? `\n\n… ${omitted()} more items omitted (raise --max-chars)` : "");
  const fits = () => compose().length + note().length + 1 <= maxChars;
  // Give every section its first block before any gets a second, so that no section starves the others. The raw
  // samples are the last thing to claim room.
  const order = all.map((_, i) => i).filter((i) => all[i]?.title !== "Samples");
  const samplesAt = all.findIndex((s) => s.title === "Samples");
  for (let progress = true; progress; ) {
    progress = false;
    for (const i of order) {
      if ((taken[i] as number) >= (all[i] as Section).blocks.length) continue;
      (taken[i] as number)++;
      if (fits()) progress = true;
      else (taken[i] as number)--;
    }
  }
  while (samplesAt >= 0 && (taken[samplesAt] as number) < (all[samplesAt] as Section).blocks.length) {
    (taken[samplesAt] as number)++;
    if (!fits()) {
      (taken[samplesAt] as number)--;
      break;
    }
  }
  const out = `${compose()}${note()}\n`;
  return out.length <= maxChars ? out : `${out.slice(0, maxChars - 2)}…\n`;
}
