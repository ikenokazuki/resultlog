#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function runDigest(args: string[]): number {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(DIGEST_HELP);
    return 0;
  }
  let file: string | undefined;
  let format = "markdown";
  let top: number | undefined;
  let maxChars: number | undefined;
  let pseudonymize = false;
  let admins: string[] | undefined;
  const thresholds: Record<string, number> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--format") format = args[++i] ?? "";
    else if (arg === "--top") top = Number(args[++i]);
    else if (arg === "--max-chars") maxChars = Number(args[++i]);
    else if (arg === "--pseudonymize") pseudonymize = true;
    else if (arg === "--admins") admins = (args[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--threshold") {
      const [name, value] = (args[++i] ?? "").split("=");
      if (!name || Number.isNaN(Number(value))) return fail("Bad --threshold, expected rule=N.", DIGEST_HELP);
      thresholds[name] = Number(value);
    } else if (!arg.startsWith("-") && file === undefined) file = arg;
    else return fail(`Unknown argument: ${arg}`, DIGEST_HELP);
  }
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
  let project: string | undefined;
  let out = "monitoring";
  let prefix: string | undefined;
  const services: string[] = [];
  const notificationChannels: string[] = [];
  const thresholds: Partial<Record<ThresholdName, number>> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = () => args[++i] ?? "";
    if (arg === "--project") project = value();
    else if (arg === "--out") out = value();
    else if (arg === "--prefix") prefix = value();
    else if (arg === "--service") services.push(...value().split(",").filter(Boolean));
    else if (arg === "--notification-channel") notificationChannels.push(value());
    else if (arg === "--threshold") {
      const [name, number] = value().split("=");
      if (!name || number === undefined || number === "" || Number.isNaN(Number(number))) return fail("Bad --threshold, expected name=N.", MONITORING_HELP);
      thresholds[name as ThresholdName] = Number(number);
    } else return fail(`Unknown argument: ${arg}`, MONITORING_HELP);
  }
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
