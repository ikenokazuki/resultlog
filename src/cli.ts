#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { digest, parseLogs } from "./digest.js";
import { files, type ThresholdName } from "./monitoring.js";

const USAGE = `resultlog <command>

Commands
  digest [file]   Turn Cloud Logging entries into a report small enough to hand to an AI assistant
  monitoring      Write Cloud Monitoring metrics, alert policies and a dashboard for what resultlog logs

Run a command with --help for its options.
`;

const DIGEST_HELP = `resultlog digest [file] [options]

Reads Cloud Logging entries (a JSON array, or one JSON value per line) from a file or from stdin, and prints a digest
that is small enough to hand to an AI assistant: findings, failure groups, security events, slow or failing hosts, LLM usage.

  gcloud logging read 'resource.type="cloud_run_revision"' --freshness=1d --format=json | npx resultlog digest

Options
  --format markdown|json   Output format (default markdown)
  --top N                  How many items to list per section (default 10)
  --max-chars N            Upper bound of the Markdown (default 20000)
  --pseudonymize           Replace uids, IP addresses and user agents with pseudonyms
  --admins uid1,uid2       Uids allowed to change permissions and accounts; a change by anyone else is a high finding
  --threshold rule=N       Change the threshold of a detection rule (repeatable), e.g. --threshold authz-probing=5
  -h, --help               Show this help
`;

const MONITORING_HELP = `resultlog monitoring --project PROJECT [options]

Writes the log-based metrics, alert policies and dashboard that make resultlog's entries visible in Cloud Monitoring.
It only writes files and never talks to Google Cloud: the README it writes says which gcloud commands apply them.

  npx resultlog monitoring --project my-project --notification-channel projects/my-project/notificationChannels/123

Options
  --project ID                  Your Google Cloud project id (required)
  --out DIR                     Where to write the files (default ./monitoring)
  --service a,b                 Cover only these functions, by Cloud Run service name (the function name in lower case)
  --notification-channel NAME   Where alerts notify, as projects/PROJECT/notificationChannels/ID (repeatable)
  --threshold name=N            Events that make an alert fire: errors, security-events, timeouts, llm-problems (repeatable)
  --prefix NAME                 Prefix of the names (default resultlog)
  -h, --help                    Show this help
`;

const fail = (message: string, help: string): number => {
  process.stderr.write(`${message}\n\n${help}`);
  return 2;
};

/** What `parseArgs` throws for an option it does not know or one that lacks its value, as a value. */
const attempt = <T>(read: () => T): T | Error => {
  try {
    return read();
  } catch (error) {
    return error as Error;
  }
};

/** A number from an option; NaN when the text is not one (an empty text is not zero). */
const numberOf = (text: string | undefined) => (text === undefined ? undefined : text.trim() === "" ? Number.NaN : Number(text));

/** `name=N` options as an object, or undefined when one is not of that form. */
function thresholdsOf(specs: string[] | undefined): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const spec of specs ?? []) {
    const [name, value] = spec.split("=");
    const number = numberOf(value);
    if (!name || number === undefined || Number.isNaN(number)) return undefined;
    out[name] = number;
  }
  return out;
}

function runDigest(args: string[]): number {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(DIGEST_HELP);
    return 0;
  }
  // `--name value` and `--name=value` alike, as every command line tool takes them.
  const read = attempt(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        format: { type: "string" },
        top: { type: "string" },
        "max-chars": { type: "string" },
        pseudonymize: { type: "boolean" },
        admins: { type: "string" },
        threshold: { type: "string", multiple: true },
      },
    }),
  );
  if (read instanceof Error) return fail(`resultlog: ${read.message}`, DIGEST_HELP);
  const { values, positionals } = read;
  if (positionals.length > 1) return fail(`Unknown argument: ${positionals[1]}`, DIGEST_HELP);
  const file = positionals[0];
  const format = values.format ?? "markdown";
  const top = numberOf(values.top);
  const maxChars = numberOf(values["max-chars"]);
  const pseudonymize = values.pseudonymize === true;
  const admins = values.admins === undefined ? undefined : values.admins.split(",").filter(Boolean);
  const thresholds = thresholdsOf(values.threshold);
  if (thresholds === undefined) return fail("Bad --threshold, expected rule=N.", DIGEST_HELP);
  if (!["markdown", "json"].includes(format) || Number.isNaN(top) || Number.isNaN(maxChars)) return fail("Bad option value.", DIGEST_HELP);
  if (file === undefined && process.stdin.isTTY) {
    process.stdout.write(DIGEST_HELP);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file ?? 0, "utf8");
  } catch (error) {
    process.stderr.write(`resultlog: cannot read ${file ?? "stdin"}: ${(error as Error).message}\n`);
    return 2;
  }
  const { logs, skipped } = parseLogs(text);
  const result = digest(logs, { top, maxChars, pseudonymize, admins, thresholds });
  process.stdout.write(format === "json" ? `${JSON.stringify(result.data, null, 2)}\n` : result.markdown);
  if (skipped > 0) process.stderr.write(`resultlog: skipped ${skipped} line(s) that were not JSON\n`);
  return 0;
}

function runMonitoring(args: string[]): number {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(MONITORING_HELP);
    return 0;
  }
  const read = attempt(() =>
    parseArgs({
      args,
      options: {
        project: { type: "string" },
        out: { type: "string" },
        prefix: { type: "string" },
        service: { type: "string", multiple: true },
        "notification-channel": { type: "string", multiple: true },
        threshold: { type: "string", multiple: true },
      },
    }),
  );
  if (read instanceof Error) return fail(`resultlog: ${read.message}`, MONITORING_HELP);
  const { project, out = "monitoring", prefix } = read.values;
  const services = (read.values.service ?? []).flatMap((names) => names.split(",")).filter(Boolean);
  const notificationChannels = read.values["notification-channel"] ?? [];
  const thresholds = thresholdsOf(read.values.threshold) as Partial<Record<ThresholdName, number>> | undefined;
  if (thresholds === undefined) return fail("Bad --threshold, expected name=N.", MONITORING_HELP);
  if (project === undefined) return fail("--project is required.", MONITORING_HELP);
  let set: Record<string, string>;
  try {
    set = files({ project, prefix, services, notificationChannels, thresholds });
  } catch (error) {
    return fail(`resultlog: ${(error as Error).message}`, MONITORING_HELP);
  }
  for (const [path, content] of Object.entries(set)) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const noChannel = "No notification channel was given: add one to each alert policy in the console, or generate again with --notification-channel.\n";
  process.stdout.write(
    `Wrote ${Object.keys(set).length} files to ${out}/. Nothing was sent to Google Cloud.\n\n` +
      `Next: read ${join(out, "README.md")}, which has the gcloud commands that apply them.\n${notificationChannels.length === 0 ? `\n${noChannel}` : ""}`,
  );
  return 0;
}

function main(argv: string[]): number {
  const [command, ...args] = argv.slice(2);
  if (command === "digest") return runDigest(args);
  if (command === "monitoring") return runMonitoring(args);
  const asked = command === "-h" || command === "--help";
  process.stdout.write(USAGE);
  return asked ? 0 : 2;
}

process.exitCode = main(process.argv);
