// Cloud Monitoring setup for what resultlog writes: log-based metrics, alert policies and a dashboard, as the JSON that
// `gcloud` takes. Nothing here talks to Google Cloud or changes anything in it: it only produces files, and the README
// among them says which gcloud commands apply them.

export type ThresholdName = "errors" | "security-events" | "timeouts" | "llm-problems";

export interface MonitoringOptions {
  /** Your Google Cloud project id. */
  project: string;
  /** Names start with it: the metrics are `<prefix>_failures` and so on, the policies and the dashboard `<prefix>: ...`. Default "resultlog". */
  prefix?: string;
  /** The functions to cover, by Cloud Run service name (the function name in lower case). Default: every function in the project. */
  services?: string[];
  /** Where the alerts notify, as `projects/PROJECT/notificationChannels/ID`. Without any, you add them in the console. */
  notificationChannels?: string[];
  /** How many events within the alert's window make it fire. Defaults: errors 5 (in 5 minutes), security-events 20 (5), timeouts 3 (10), llm-problems 5 (10). */
  thresholds?: Partial<Record<ThresholdName, number>>;
}

type Json = Record<string, any>;

export interface LogMetric extends Json {
  name: string;
  description: string;
  filter: string;
  metricDescriptor: Json;
  labelExtractors?: Record<string, string>;
}

export interface AlertPolicy extends Json {
  displayName: string;
  conditions: Json[];
}

export interface Monitoring {
  /** Log-based metrics, by name. */
  metrics: Record<string, LogMetric>;
  /** Alert policies, by the file name they are written to. */
  alerts: Record<string, AlertPolicy>;
  dashboard: Json;
}

// These end up in filters and in the README's shell commands, so they are checked, not escaped.
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PREFIX = /^[a-z][a-z0-9_]{0,30}$/;
const SERVICE = /^[a-z][a-z0-9-]{0,62}$/;
const CHANNEL = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/notificationChannels\/\d+$/;

function check(options: MonitoringOptions) {
  const bad = (what: string, value: unknown) => {
    throw new Error(`Bad ${what}: ${JSON.stringify(value)}`);
  };
  const { project, prefix = "resultlog", services = [], notificationChannels = [], thresholds = {} } = options;
  if (!PROJECT.test(project ?? "")) bad("project id", project);
  if (!PREFIX.test(prefix)) bad("prefix (lower case letters, digits and underscores, starting with a letter)", prefix);
  for (const service of services) if (!SERVICE.test(service)) bad("service name (lower case letters, digits and hyphens)", service);
  for (const channel of notificationChannels) if (!CHANNEL.test(channel)) bad("notification channel (projects/PROJECT/notificationChannels/ID)", channel);
  for (const [name, value] of Object.entries(thresholds)) {
    if (!["errors", "security-events", "timeouts", "llm-problems"].includes(name)) bad("threshold name", name);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) bad(`threshold for ${name}`, value);
  }
  return { project, prefix, services, notificationChannels, thresholds };
}

// ---- Metrics -----------------------------------------------------------------------------------------------------

interface MetricSpec {
  key: string;
  description: string;
  /** Which entries count. Entries are matched on the fields resultlog writes. */
  where: string;
  /** Labels hold few distinct values: never a user id, an address or an id of any kind, which would cost a time series each. */
  labels?: Record<string, { from: string; description: string }>;
}

const SEVERITY = { from: "severity", description: "Log severity" };
const METRICS: MetricSpec[] = [
  {
    key: "failures",
    description: "Invocations that ended in an error (one per final entry that has an errorName).",
    where: "jsonPayload.errorName:* AND jsonPayload.durationMs:*",
    labels: {
      severity: SEVERITY,
      error_name: { from: "jsonPayload.errorName", description: "Name of the error" },
      error_code: { from: "jsonPayload.errorCode", description: "Firebase error code" },
    },
  },
  {
    key: "security_events",
    description: "Security events: refused calls, rejected input, replayed tokens, and what logContext.security() records.",
    where: "jsonPayload.securityEvent:*",
    labels: { event: { from: "jsonPayload.securityEvent", description: "OWASP Logging Vocabulary name" }, severity: SEVERITY },
  },
  {
    key: "audit_events",
    description: "Audit events: what logContext.audit() records, and sign-ins and sign-ups from wrapBlocking.",
    where: "jsonPayload.auditEvent:*",
    labels: { event: { from: "jsonPayload.auditEvent", description: "Audit event name" } },
  },
  { key: "timeouts", description: "Invocations the timeout guard cut off.", where: 'jsonPayload.errorName="DeadlineExceeded"' },
  { key: "cold_starts", description: "First invocations of an instance.", where: "jsonPayload.coldStart=true" },
  { key: "duplicate_events", description: "Events skipped because they were processed already.", where: "jsonPayload.duplicate=true" },
  { key: "llm_truncated", description: "Invocations with an LLM answer that was cut off.", where: "jsonPayload.llm.truncated>0" },
  { key: "llm_blocked", description: "Invocations with an LLM answer that was withheld.", where: "jsonPayload.llm.blocked>0" },
  { key: "llm_interrupted", description: "Invocations with an LLM stream that was cut short.", where: "jsonPayload.llm.interrupted>0" },
];

/** `resource.type="cloud_run_revision"`, and the functions to cover: a Logging query. */
const logScope = (services: string[]) =>
  `resource.type="cloud_run_revision"${services.length ? ` AND resource.labels.service_name=(${services.map((s) => `"${s}"`).join(" OR ")})` : ""}`;

/** The same for a Monitoring filter, which spells resource labels and lists differently. */
const metricScope = (services: string[]) =>
  `resource.type="cloud_run_revision"${services.length ? ` AND resource.label.service_name=one_of(${services.map((s) => `"${s}"`).join(",")})` : ""}`;

function logMetrics(prefix: string, services: string[]): Record<string, LogMetric> {
  const out: Record<string, LogMetric> = {};
  for (const spec of METRICS) {
    const name = `${prefix}_${spec.key}`;
    const labels = Object.entries(spec.labels ?? {});
    out[name] = {
      name,
      description: spec.description,
      filter: `${logScope(services)} AND ${spec.where}`,
      metricDescriptor: {
        metricKind: "DELTA",
        valueType: "INT64",
        unit: "1",
        ...(labels.length > 0 ? { labels: labels.map(([key, { description }]) => ({ key, valueType: "STRING", description })) } : {}),
      },
      ...(labels.length > 0 ? { labelExtractors: Object.fromEntries(labels.map(([key, { from }]) => [key, `EXTRACT(${from})`])) } : {}),
    };
  }
  return out;
}

// ---- Alert policies ----------------------------------------------------------------------------------------------

const metricType = (prefix: string, key: string) => `logging.googleapis.com/user/${prefix}_${key}`;
const DIGEST = "gcloud logging read 'resource.type=\"cloud_run_revision\"' --freshness=1h --format=json | npx resultlog digest";

function documentation(means: string, todo: string): Json {
  return {
    mimeType: "text/markdown",
    content: `**What it means:** ${means}\n\n**What to do:** ${todo}\n\nSee which entries and who is behind them: \`${DIGEST}\``,
  };
}

// What Google Cloud itself records about the project, in the Admin Activity audit log. It is always written, and cannot be
// configured, excluded or switched off, so these alerts need nothing else to be turned on. Its entries are not the
// functions' (another resource type, no jsonPayload from resultlog), so the --service scope does not apply to them. The
// method names are the ones Google documents; `:` ignores case and takes a part, which is what makes "SetIamPolicy" cover
// the service account variant `google.iam.admin.v1.SetIAMPolicy` and the ones with a prefix.
const ADMIN_ACTIVITY = 'logName:"cloudaudit.googleapis.com%2Factivity"';
const CHANGE_FILTERS = {
  rules: `${ADMIN_ACTIVITY} AND protoPayload.serviceName="firebaserules.googleapis.com" AND protoPayload.methodName:("CreateRuleset" OR "CreateRelease" OR "UpdateRelease" OR "DeleteRelease" OR "DeleteRuleset")`,
  iam: `${ADMIN_ACTIVITY} AND protoPayload.methodName:"SetIamPolicy"`,
  key: `${ADMIN_ACTIVITY} AND protoPayload.serviceName="iam.googleapis.com" AND protoPayload.methodName=("google.iam.admin.v1.CreateServiceAccountKey" OR "google.iam.admin.v1.UploadServiceAccountKey")`,
  // API keys are not under firebase.googleapis.com: they are the API Keys API's.
  firebase: `${ADMIN_ACTIVITY} AND protoPayload.serviceName=("firebase.googleapis.com" OR "apikeys.googleapis.com")`,
};

function changeDocumentation(means: string, todo: string, filter: string): Json {
  const who = "table(timestamp,protoPayload.authenticationInfo.principalEmail,protoPayload.requestMetadata.callerIp,protoPayload.methodName)";
  return {
    mimeType: "text/markdown",
    content: `**What it means:** ${means}\n\n**What to do:** ${todo}\n\nWho did it, and from where: \`gcloud logging read '${filter}' --freshness=1d --format='${who}'\``,
  };
}

function alerts(prefix: string, services: string[], channels: string[], thresholds: Partial<Record<ThresholdName, number>>): Record<string, AlertPolicy> {
  const base = { enabled: true, combiner: "OR", notificationChannels: channels, userLabels: { source: "resultlog" } };
  const counted = (title: string, key: string, extra: string, groupBy: string[], value: number, minutes: number): Json => ({
    displayName: title,
    conditionThreshold: {
      filter: `metric.type="${metricType(prefix, key)}" AND ${metricScope(services)}${extra}`,
      aggregations: [{ alignmentPeriod: `${minutes * 60}s`, perSeriesAligner: "ALIGN_DELTA", crossSeriesReducer: "REDUCE_SUM", groupByFields: ["resource.label.service_name", ...groupBy] }],
      comparison: "COMPARISON_GT",
      thresholdValue: value,
      duration: "0s",
      trigger: { count: 1 },
    },
  });
  const onEntry = (title: string, filter: string): Json => ({ displayName: title, conditionMatchedLog: { filter: `${logScope(services)} AND ${filter}` } });
  const errors = thresholds.errors ?? 5;
  const security = thresholds["security-events"] ?? 20;
  const timeouts = thresholds.timeouts ?? 3;
  const llm = thresholds["llm-problems"] ?? 5;
  return {
    "server-errors": {
      ...base,
      displayName: `${prefix}: server errors`,
      severity: "ERROR",
      documentation: documentation(
        `More than ${errors} invocations of one function ended in a server-side error (severity ERROR or worse) within 5 minutes. Expected failures such as not-found are WARNING and don't count.`,
        "Open the failure groups in the digest, start with the most frequent `id`, and read its message, upstream calls and breadcrumbs.",
      ),
      conditions: [counted("Server errors per function", "failures", ' AND metric.label.severity=one_of("ERROR","CRITICAL","ALERT","EMERGENCY")', ["metric.label.error_name"], errors, 5)],
    },
    "security-events": {
      ...base,
      displayName: `${prefix}: security events surge`,
      severity: "WARNING",
      documentation: documentation(
        `More than ${security} security events of one kind (refused calls, rejected input, ...) within 5 minutes.`,
        "Look at the findings in the digest: they name the actors and addresses behind the events (authz-probing, validation-fuzzing, many-accounts-one-ip, ...).",
      ),
      conditions: [counted("Security events per function and kind", "security_events", "", ["metric.label.event"], security, 5)],
    },
    "token-replay": {
      ...base,
      displayName: `${prefix}: App Check token replayed`,
      severity: "CRITICAL",
      alertStrategy: { notificationRateLimit: { period: "300s" } },
      documentation: documentation(
        "An App Check token was used a second time: a recorded request is being replayed.",
        "Make sure replay protection (`consumeAppCheckToken`) is on for the endpoint and that requests whose token was already consumed are refused.",
      ),
      conditions: [onEntry("A replayed App Check token", 'jsonPayload.securityEvent="authn_token_reuse"')],
    },
    "permission-changes": {
      ...base,
      displayName: `${prefix}: permissions or accounts changed`,
      severity: "WARNING",
      alertStrategy: { notificationRateLimit: { period: "300s" } },
      documentation: documentation(
        "Someone changed permissions, or created, updated or deleted an account (an audit event such as authz_change or user_deleted).",
        "Check that the change was meant. The entry says who made it and from where.",
      ),
      conditions: [onEntry("A permission or account change", 'jsonPayload.auditEvent=~"^(authz_(change|admin)|privilege_|user_(created|updated|archived|deleted))"')],
    },
    timeouts: {
      ...base,
      displayName: `${prefix}: functions timing out`,
      severity: "WARNING",
      documentation: documentation(
        `More than ${timeouts} invocations of one function were cut off by the timeout guard within 10 minutes.`,
        "Look at the upstream calls in the failure group (`pending` shows a call that never answered) and at the function's timeout setting.",
      ),
      conditions: [counted("Timeouts per function", "timeouts", "", [], timeouts, 10)],
    },
    "llm-problems": {
      ...base,
      displayName: `${prefix}: LLM answers cut off, withheld or interrupted`,
      severity: "WARNING",
      documentation: documentation(
        `More than ${llm} invocations of one function had an LLM answer that was cut off, withheld by a filter, or interrupted within 10 minutes.`,
        "Check max_tokens, the prompt and the provider's status. These arrive with a 200, so no error was raised.",
      ),
      conditions: [
        counted("Answers cut off", "llm_truncated", "", [], llm, 10),
        counted("Answers withheld", "llm_blocked", "", [], llm, 10),
        counted("Streams interrupted", "llm_interrupted", "", [], llm, 10),
      ],
    },
    "rules-changed": {
      ...base,
      displayName: `${prefix}: Firebase Security Rules changed`,
      severity: "ERROR",
      alertStrategy: { notificationRateLimit: { period: "300s" } },
      documentation: changeDocumentation(
        "Someone created, updated or deleted a ruleset or a release of Firebase Security Rules (Firestore, Cloud Storage, Realtime Database). Deploying your own rules does exactly this.",
        "Check that it was your deploy: the entry names the account and the address. A rule that opens a collection to everyone is how data leaks.",
        CHANGE_FILTERS.rules,
      ),
      conditions: [{ displayName: "Security Rules changed", conditionMatchedLog: { filter: CHANGE_FILTERS.rules } }],
    },
    "iam-changed": {
      ...base,
      displayName: `${prefix}: IAM policy changed`,
      severity: "ERROR",
      alertStrategy: { notificationRateLimit: { period: "300s" } },
      documentation: changeDocumentation(
        "An IAM policy was set: members were added or removed or roles changed, on the project, on a service account, or on another resource such as a function (making a function public grants allUsers the invoker role).",
        "Check that the change was meant. The entry's request and response hold the policy that was set.",
        CHANGE_FILTERS.iam,
      ),
      conditions: [{ displayName: "IAM policy set", conditionMatchedLog: { filter: CHANGE_FILTERS.iam } }],
    },
    "service-account-key": {
      ...base,
      displayName: `${prefix}: service account key created`,
      severity: "ERROR",
      alertStrategy: { notificationRateLimit: { period: "300s" } },
      documentation: changeDocumentation(
        "A key, a JSON file that works as a password, was created for a service account, or one was uploaded.",
        "Prefer no keys at all (attached service accounts, workload identity). If it was not you, delete the key at once with `gcloud iam service-accounts keys delete`, then rotate whatever the account can reach and look at what it has done.",
        CHANGE_FILTERS.key,
      ),
      conditions: [{ displayName: "Service account key created", conditionMatchedLog: { filter: CHANGE_FILTERS.key } }],
    },
    "firebase-changed": {
      ...base,
      displayName: `${prefix}: Firebase project or API key changed`,
      severity: "WARNING",
      alertStrategy: { notificationRateLimit: { period: "300s" } },
      documentation: changeDocumentation(
        "A setting of the Firebase project changed (an app was added, changed or removed, a SHA certificate, the project itself), or an API key was created or changed.",
        "Check that it was meant. An app you do not know, or a key whose restrictions were lifted, is worth acting on.",
        CHANGE_FILTERS.firebase,
      ),
      conditions: [{ displayName: "Firebase project or API key changed", conditionMatchedLog: { filter: CHANGE_FILTERS.firebase } }],
    },
  };
}

// ---- Dashboard ---------------------------------------------------------------------------------------------------

function dashboard(prefix: string, project: string, services: string[]): Json {
  const aggregation = (aligner: string, reducer: string, groupBy: string[]) => ({
    alignmentPeriod: "60s",
    perSeriesAligner: aligner,
    crossSeriesReducer: reducer,
    groupByFields: groupBy,
  });
  /** A chart of a counter: events per minute, stacked, one series per value of `groupBy`. */
  const counts = (title: string, sets: { key: string; legend?: string; groupBy?: string[] }[]) => ({
    title,
    xyChart: {
      dataSets: sets.map(({ key, legend, groupBy = [] }) => ({
        timeSeriesQuery: { timeSeriesFilter: { filter: `metric.type="${metricType(prefix, key)}" AND ${metricScope(services)}`, aggregation: aggregation("ALIGN_DELTA", "REDUCE_SUM", groupBy) } },
        plotType: "STACKED_BAR",
        minAlignmentPeriod: "60s",
        ...(legend ? { legendTemplate: legend } : {}),
      })),
      yAxis: { scale: "LINEAR" },
    },
  });
  const cloudRun = (title: string, metric: string, plotType: string, aligner: string, reducer: string, groupBy: string[], legend?: string) => ({
    timeSeriesQuery: { timeSeriesFilter: { filter: `metric.type="run.googleapis.com/${metric}" AND ${metricScope(services)}`, aggregation: aggregation(aligner, reducer, groupBy) } },
    plotType,
    minAlignmentPeriod: "60s",
    ...(legend ? { legendTemplate: legend } : {}),
    title,
  });
  const requests = cloudRun("Requests", "request_count", "STACKED_BAR", "ALIGN_DELTA", "REDUCE_SUM", ["metric.label.response_code_class"]);
  const latency = (aligner: string, legend: string) => cloudRun("Latency", "request_latencies", "LINE", aligner, "REDUCE_MAX", ["resource.label.service_name"], legend);
  const { title: _a, ...requestsSet } = requests;
  const { title: _b, ...p50 } = latency("ALIGN_PERCENTILE_50", "p50");
  const { title: _c, ...p95 } = latency("ALIGN_PERCENTILE_95", "p95");
  const tile = (xPos: number, yPos: number, width: number, height: number, widget: Json) => ({ xPos, yPos, width, height, widget });
  const panel = (title: string, filter: string) => ({ title, logsPanel: { filter: `${logScope(services)} AND ${filter}`, resourceNames: [`projects/${project}`] } });
  return {
    displayName: `${prefix}: functions`,
    mosaicLayout: {
      columns: 12,
      tiles: [
        tile(0, 0, 12, 2, {
          title: "About this dashboard",
          text: {
            format: "MARKDOWN",
            content:
              "resultlog writes one entry per invocation. The charts count what it wrote (log-based metrics, and Cloud Run's own request metrics); the panels at the bottom list the entries.\n\nPer user or per address? Metrics must not carry those. Run the digest: `gcloud logging read 'resource.type=\"cloud_run_revision\"' --freshness=1d --format=json | npx resultlog digest`",
          },
        }),
        tile(0, 2, 6, 4, { title: "Requests by response class (Cloud Run)", xyChart: { dataSets: [requestsSet], yAxis: { scale: "LINEAR" } } }),
        tile(6, 2, 6, 4, { title: "Request latency, p50 and p95 (Cloud Run)", xyChart: { dataSets: [p50, p95], yAxis: { scale: "LINEAR" } } }),
        tile(0, 6, 6, 4, counts("Failures by error", [{ key: "failures", groupBy: ["metric.label.error_name"] }])),
        tile(6, 6, 6, 4, counts("Security events by kind", [{ key: "security_events", groupBy: ["metric.label.event"] }])),
        tile(0, 10, 6, 4, counts("Audit events by kind", [{ key: "audit_events", groupBy: ["metric.label.event"] }])),
        tile(
          6,
          10,
          6,
          4,
          counts("Timeouts, duplicate events and cold starts", [
            { key: "timeouts", legend: "timeouts" },
            { key: "duplicate_events", legend: "duplicate events" },
            { key: "cold_starts", legend: "cold starts" },
          ]),
        ),
        tile(
          0,
          14,
          12,
          4,
          counts("LLM answers cut off, withheld or interrupted", [
            { key: "llm_truncated", legend: "cut off" },
            { key: "llm_blocked", legend: "withheld" },
            { key: "llm_interrupted", legend: "interrupted" },
          ]),
        ),
        tile(0, 18, 12, 6, panel("Security and audit entries", "(jsonPayload.securityEvent:* OR jsonPayload.auditEvent:*)")),
        tile(0, 24, 12, 6, panel("Failures (ERROR and worse)", "severity>=ERROR AND jsonPayload.errorName:*")),
      ],
    },
  };
}

// ---- The result ------------------------------------------------------------------------------------------------

/** The log-based metrics, alert policies and dashboard for what resultlog writes. */
export function monitoring(options: MonitoringOptions): Monitoring {
  const { project, prefix, services, notificationChannels, thresholds } = check(options);
  return {
    metrics: logMetrics(prefix, services),
    alerts: alerts(prefix, services, notificationChannels, thresholds),
    dashboard: dashboard(prefix, project, services),
  };
}

function readme(project: string, m: Monitoring, options: MonitoringOptions): string {
  const policies = Object.values(m.alerts).map((p) => `- ${p.displayName}`).join("\n");
  const channels = (options.notificationChannels ?? []).length > 0;
  return `# resultlog monitoring for ${project}

Generated by \`npx resultlog monitoring\`.

## Apply

Nothing here has been applied, and resultlog never applies it for you: these are files to read, change if you like, and
apply with the gcloud CLI. Sign in with permission to create log-based metrics, alert policies and dashboards in the
project, then run, from this directory:

\`\`\`bash
# The log-based metrics (each file is named after its metric)
for f in metrics/*.json; do
  gcloud logging metrics create "$(basename "$f" .json)" --config-from-file "$f" --project ${project}
done

# The alert policies
for f in alerts/*.json; do
  gcloud monitoring policies create --policy-from-file "$f" --project ${project}
done

# The dashboard. Add --validate-only to have Google check the file without creating anything.
gcloud monitoring dashboards create --config-from-file dashboard.json --project ${project}
\`\`\`

Run these once. \`metrics create\` refuses a metric that exists, but \`policies create\` and \`dashboards create\` add a
second copy. To change what you applied (a threshold, say: generate again with \`--threshold errors=10\`), replace it:

\`\`\`bash
gcloud logging metrics update resultlog_failures --config-from-file metrics/resultlog_failures.json --project ${project}

gcloud monitoring policies list --project ${project} --filter='displayName="resultlog: server errors"' --format='value(name)'
gcloud monitoring policies update POLICY_NAME_FROM_ABOVE --policy-from-file alerts/server-errors.json --project ${project}
\`\`\`

\`policies update\` replaces the whole policy with the file, including anything you changed in the console. A dashboard
cannot be updated from a file without its current etag, so delete it (\`gcloud monitoring dashboards list\`, then
\`dashboards delete\`) and create it again.

To notify somewhere, list your notification channels with
\`gcloud beta monitoring channels list --project ${project} --format='value(name,displayName)'\` and generate again with
\`--notification-channel projects/${project}/notificationChannels/ID\`.

## What you get

- ${Object.keys(m.metrics).length} log-based metrics (\`${Object.keys(m.metrics)[0]}\`, ...). Their labels hold few values (event, error name, severity), never a user id or an address: every distinct value is a time series that costs money. Check Cloud Monitoring's pricing for user-defined metrics.
- ${Object.keys(m.alerts).length} alert policies:
${policies}
- the dashboard "${m.dashboard.displayName}": Cloud Run's request count and latency next to resultlog's metrics, and panels that list the security, audit and failure entries.

${channels ? "The alerts notify the channels you gave." : "The alerts have no notification channel yet: add one to each policy in the console, or generate again with --notification-channel."}

## Things to know

- Counts come from log entries. With \`successSampleRate\` below 1 the metrics still count every failure, security event and audit event (those are always logged); only ordinary successes are thinned, which is why the request charts use Cloud Run's own metrics.
- Per user or per address, run the digest: \`gcloud logging read 'resource.type="cloud_run_revision"' --freshness=1d --format=json | npx resultlog digest\`.
- Thresholds are starting points: generate again with \`--threshold errors=10\` and replace the policy as described above.
- Four of the alerts (Security Rules changed, IAM policy changed, service account key created, Firebase project or API key changed) are not about the functions: they watch the Admin Activity audit log, which Google always writes, for the whole project. They fire on your own deploys and changes too, which is the point: check that it was you. Delete the files under \`alerts/\` that you do not want before you apply.
`;
}

/** Everything to write, by path: the metric and policy files, the dashboard, and a README that says how to apply them. */
export function files(options: MonitoringOptions): Record<string, string> {
  const { project } = check(options);
  const m = monitoring(options);
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "README.md": readme(project, m, options),
    "dashboard.json": json(m.dashboard),
    ...Object.fromEntries(Object.entries(m.metrics).map(([name, metric]) => [`metrics/${name}.json`, json(metric)])),
    ...Object.fromEntries(Object.entries(m.alerts).map(([slug, policy]) => [`alerts/${slug}.json`, json(policy)])),
  };
}
