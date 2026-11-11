// Runs the packed package in the real Firebase Functions emulator and checks what it answers and what it logs. The unit
// tests fake the platform, and Bun is not Node, so this is where the Functions runtime itself (the callable protocol,
// FUNCTIONS_EMULATOR, the trace context, Express's `trust proxy`) meets resultlog.
//
//   npm run emulator                                   pack, install into a scratch project, run the emulator, check
//   npm run emulator -- --keep                         keep the scratch project too (it is kept when a check fails)
//   node scripts/emulator-check.mjs --analyze LOG RESULTS   only check a recorded run
//
// Needs the firebase CLI (on PATH, or FIREBASE_CLI=/path/to/firebase), Node 22 or later and a network for `npm install`.
// No Java: the Functions emulator is Node only. The Firestore and Pub/Sub emulators are not used.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEntries, runChecks } from "./emulator/checks.mjs";
import { PROJECT } from "./emulator/scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "scripts", "emulator");
const args = process.argv.slice(2);

const readResults = (path) => {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return Object.fromEntries(lines.map((line) => JSON.parse(line)).map((result) => [result.name, result]));
  } catch {
    return {}; // the driver never ran: every check then fails
  }
};

/** Prints the outcome of the checks and returns the exit status. */
function report(log, results) {
  const outcome = runChecks(readEntries(log), results);
  for (const { ok, what } of outcome) console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  const failed = outcome.filter((check) => !check.ok).length;
  console.log(`\nemulator check: ${outcome.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

/** A setup problem, not a failed check: it ends the run with status 2, after the scratch project has been dealt with. */
class Stop extends Error {}
const stop = (message) => {
  throw new Stop(message);
};

const run = (command, commandArgs, options = {}) => spawnSync(command, commandArgs, { encoding: "utf8", ...options });

/** Free ports, found together so that they differ. A running emulator of your own keeps its ports. */
async function freePorts(count) {
  const servers = await Promise.all(
    Array.from({ length: count }, () => new Promise((done) => { const server = createServer(); server.listen(0, "127.0.0.1", () => done(server)); })),
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  return ports;
}

async function main() {
  const cli = process.env.FIREBASE_CLI ?? "firebase";
  if (run(cli, ["--version"]).status !== 0) {
    stop(`the firebase CLI is not available (looked for "${cli}"). Install it with \`npm install -g firebase-tools\`, or point FIREBASE_CLI at it.`);
  }
  const work = mkdtempSync(join(tmpdir(), "resultlog-emulator-"));
  let keep = args.includes("--keep");
  try {
    console.log("packing the package (this builds it)...");
    const packed = run("npm", ["pack", "--pack-destination", work, "--silent"], { cwd: root });
    if (packed.status !== 0) stop(`npm pack failed:\n${packed.stderr}`);
    const tarball = packed.stdout.trim().split("\n").pop();

    // The versions the unit tests use, so that what runs here is what is tested there.
    const dev = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies;
    const functions = join(work, "functions");
    mkdirSync(functions);
    writeFileSync(
      join(functions, "package.json"),
      JSON.stringify({
        name: "functions",
        private: true,
        main: "index.js",
        engines: { node: process.versions.node.split(".")[0] },
        // neverthrow is not listed: it has to come with resultlog
        dependencies: { "firebase-admin": dev["firebase-admin"], "firebase-functions": dev["firebase-functions"], zod: dev.zod, resultlog: `file:../${tarball}` },
      }),
    );
    writeFileSync(join(functions, "index.js"), readFileSync(join(here, "functions.cjs")));
    const [port, hub, logging] = await freePorts(3);
    writeFileSync(
      join(work, "firebase.json"),
      JSON.stringify({
        functions: [{ source: "functions", codebase: "default" }],
        emulators: { functions: { host: "127.0.0.1", port }, hub: { host: "127.0.0.1", port: hub }, logging: { host: "127.0.0.1", port: logging }, ui: { enabled: false }, singleProjectMode: true },
      }),
    );
    writeFileSync(join(work, ".firebaserc"), JSON.stringify({ projects: { default: PROJECT } }));

    console.log("installing the scratch project's dependencies...");
    const installed = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: functions });
    if (installed.status !== 0) {
      keep = true;
      stop(`npm install failed (kept ${work}):\n${installed.stderr.split("\n").slice(-15).join("\n")}`);
    }

    console.log(`running the Functions emulator on port ${port} (about half a minute)...`);
    const resultsPath = join(work, "results.jsonl");
    const quote = (text) => `"${text.replaceAll('"', '\\"')}"`;
    const driver = `${quote(process.execPath)} ${quote(join(here, "drive.mjs"))} ${quote(resultsPath)} ${port}`;
    // The emulator talks to itself and to nothing else. A proxy variable would send its own calls to localhost through the proxy.
    const env = { ...process.env, CI: "1" };
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) delete env[name];
    const child = spawn(cli, ["emulators:exec", "--only", "functions", "--project", PROJECT, "--non-interactive", driver], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    await new Promise((done) => child.on("close", done));
    clearTimeout(timer);
    writeFileSync(join(work, "emulator.log"), log);

    const status = report(log, readResults(resultsPath));
    if (status !== 0) keep = true;
    process.exitCode = status;
  } finally {
    if (keep) console.log(`the scratch project is kept: ${work} (emulator.log and results.jsonl are in it)`);
    else rmSync(work, { recursive: true, force: true });
  }
}

try {
  if (args[0] === "--analyze") {
    const [logPath, resultsPath] = args.slice(1);
    if (!logPath || !resultsPath) stop("usage: node scripts/emulator-check.mjs --analyze <emulator.log> <results.jsonl>");
    process.exitCode = report(readFileSync(logPath, "utf8"), readResults(resultsPath));
  } else {
    await main();
  }
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(`emulator check: ${error.message}`);
  process.exitCode = 2;
}
