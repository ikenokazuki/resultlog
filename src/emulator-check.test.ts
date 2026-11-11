import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `npm run emulator` runs the packed package in the real Functions emulator and then checks the emulator's output. The
// emulator is too heavy for these tests, so the checking is run on recorded output: a run in which everything happened as
// it should (written out by hand below, from what the checks are meant to demand), and the same run with one thing broken.

const script = join(import.meta.dir, "..", "scripts", "emulator-check.mjs");
const trace = "projects/demo-resultlog/traces/105445aa7843bc8bf206b12000100000";
const verification = {
  verifications: { app: "MISSING", auth: "MISSING" },
  "logging.googleapis.com/labels": { "firebase-log-type": "callable-request-verification" },
  severity: "DEBUG",
  message: "Callable request verification passed",
};
const actor = { uid: null, appCheck: "missing", ip: "203.0.113.9", forwardedFor: "192.0.2.99, 203.0.113.9", userAgent: "emu-check/1.0" };
const error = (status: string, message: string, details?: object) => ({ error: { status, message, ...(details ? { details } : {}) } });

type Scenario = { status: number; body: object; entries: object[]; firebase?: boolean };
const goodRun = (): Record<string, Scenario> => ({
  okCall: { status: 200, body: { result: { hello: "x" } }, entries: [{ severity: "INFO", message: "okCall ok 0 ms", "logging.googleapis.com/trace": trace }] },
  missing: {
    status: 404,
    body: error("NOT_FOUND", "Order not found.", { reason: "OrderNotFound" }),
    entries: [{ severity: "WARNING", errorName: "OrderNotFound", message: "orders/o1 missing" }],
  },
  thrown: {
    status: 500,
    body: error("INTERNAL", "INTERNAL"),
    entries: [{ severity: "ERROR", errorName: "TypeError", message: "TypeError: boom\n    at run (/workspace/index.js:9:11)", cause: { name: "TypeError", message: "boom" } }],
  },
  plainError: { status: 500, body: error("INTERNAL", "INTERNAL"), entries: [{ severity: "ERROR", errorName: "Error", message: "Error: returned" }] },
  validatedBad: {
    status: 400,
    body: error("INVALID_ARGUMENT", "INVALID_ARGUMENT", { reason: "InvalidInput", issues: [{ path: ["id"], message: "Invalid input" }] }),
    entries: [{ severity: "WARNING", errorName: "InvalidInput", securityEvent: "input_validation_fail", actor }],
  },
  deniedAnon: {
    status: 401,
    body: error("UNAUTHENTICATED", "UNAUTHENTICATED", { reason: "NotSignedIn" }),
    entries: [{ severity: "WARNING", securityEvent: "authz_fail", actor, httpRequest: { status: 401, remoteIp: "203.0.113.9" } }],
  },
  deniedAuth: { status: 200, body: { result: { uid: "uid-RAW-1" } }, entries: [{ severity: "INFO", authUid: "uid-RAW-1" }] },
  audited: {
    status: 200,
    body: { result: 1 },
    entries: [
      { severity: "NOTICE", auditEvent: "sensitive_read", actor: { ...actor, uid: "uid-RAW-1" } },
      { severity: "INFO", auditEvents: ["sensitive_read"], authUid: "uid-RAW-1" },
    ],
  },
  slow: { status: 504, body: error("DEADLINE_EXCEEDED", "DEADLINE_EXCEEDED"), entries: [{ severity: "ERROR", errorName: "DeadlineExceeded" }] },
  stacked: {
    status: 500,
    body: error("INTERNAL", "INTERNAL"),
    entries: [
      {
        severity: "ERROR",
        message: "Error: retry() wraps a call that already retried internally: GET http://127.0.0.1:5001/demo-resultlog/us-central1/echoStatus was sent again after it failed (2 times in one attempt).",
      },
    ],
  },
  twice: { status: 200, body: { result: 1 }, entries: [{ severity: "INFO", external: { "127.0.0.1:5001": { calls: 2, statuses: { "200": 2 } } } }] },
  httpOk: { status: 200, body: { method: "GET" }, entries: [{ severity: "INFO", httpRequest: { status: 200 } }], firebase: false },
  httpFail: { status: 404, body: error("NOT_FOUND", "Order not found."), entries: [{ severity: "WARNING", httpRequest: { status: 404 } }], firebase: false },
});

/** What the emulator would have printed, and what the driver would have recorded. */
function recorded(run: Record<string, Scenario>) {
  const lines = ["(node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.", 'i  emulators: Starting emulators: functions'];
  for (const [name, scenario] of Object.entries(run)) {
    lines.push(`i  functions: Beginning execution of "us-central1-marker"`, `>  MARKER:${name}`, `i  functions: Finished "us-central1-marker" in 3ms`);
    if (scenario.firebase !== false) lines.push(`>  ${JSON.stringify(verification)}`);
    for (const entry of scenario.entries) lines.push(`>  ${JSON.stringify(entry)}`);
    lines.push(">  {this is not json", `i  functions: Finished "us-central1-${name}" in 12ms`);
  }
  lines.push(">  MARKER:END");
  const results = Object.entries(run).map(([name, s]) => JSON.stringify({ name, status: s.status, ms: 5, body: JSON.stringify(s.body) }));
  return { log: lines.join("\n"), results: results.join("\n") };
}

function check(run: Record<string, Scenario>, resultsOverride?: string) {
  const { log, results } = recorded(run);
  const dir = mkdtempSync(join(tmpdir(), "resultlog-emulator-test-"));
  writeFileSync(join(dir, "emulator.log"), log);
  writeFileSync(join(dir, "results.jsonl"), resultsOverride ?? results);
  const out = spawnSync("node", [script, "--analyze", join(dir, "emulator.log"), join(dir, "results.jsonl")], { encoding: "utf8" });
  return { status: out.status, failed: out.stdout.split("\n").filter((line) => line.startsWith("FAIL")), passed: out.stdout.split("\n").filter((line) => line.startsWith("PASS")) };
}

describe("the checks of `npm run emulator`", () => {
  test("pass a run in which everything happened as it should, and ignore the emulator's other lines", () => {
    const { status, failed, passed } = check(goodRun());
    expect(failed).toEqual([]);
    expect(passed).toHaveLength(14);
    expect(status).toBe(0);
  });

  test("fail a thrown exception that is logged under AppError: the log has to say what was thrown", () => {
    const run = goodRun();
    (run.thrown as Scenario).entries = [{ ...(run.thrown as Scenario).entries[0], errorName: "AppError" }];
    const { status, failed } = check(run);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("a thrown exception");
    expect(status).toBe(1);
  });

  test("fail a stack that is written twice, in the message and in the cause", () => {
    const run = goodRun();
    (run.thrown as Scenario).entries = [{ ...(run.thrown as Scenario).entries[0], cause: { name: "TypeError", message: "boom", stack: "TypeError: boom\n    at run" } }];
    const { failed } = check(run);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("a thrown exception");
  });

  test("fail an address that is the one the client wrote first, not the one the trusted proxy added", () => {
    const run = goodRun();
    (run.deniedAnon as Scenario).entries = [{ severity: "WARNING", securityEvent: "authz_fail", actor: { ...actor, ip: "192.0.2.99" }, httpRequest: { status: 401, remoteIp: "192.0.2.99" } }];
    const { failed } = check(run);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("the entry the trusted proxy added");
  });

  test("fail two answered requests that are reported as a retry", () => {
    const run = goodRun();
    (run.twice as Scenario).entries = [{ severity: "INFO", retries: [{ attempts: 1, repeatedRequest: { count: 2 } }], external: { "127.0.0.1:5001": { calls: 2, statuses: { "200": 2 } } } }];
    expect(check(run).failed[0]).toContain("not a retry");
  });

  test("fail the lack of Firebase's own DEBUG entry, which the README's Log cost section describes", () => {
    const run = goodRun();
    (run.okCall as Scenario).firebase = false;
    expect(check(run).failed[0]).toContain("Firebase writes a DEBUG entry of its own");
  });

  test("fail a scenario that left nothing behind: no entry, no answer is never a pass", () => {
    const run = goodRun();
    (run.stacked as Scenario).entries = [];
    expect(check(run).failed[0]).toContain("a retry that wraps a self-retrying call");

    const { log } = recorded(goodRun());
    const dir = mkdtempSync(join(tmpdir(), "resultlog-emulator-test-"));
    writeFileSync(join(dir, "emulator.log"), log);
    writeFileSync(join(dir, "results.jsonl"), ""); // the driver never ran: nothing the client received is known
    const out = spawnSync("node", [script, "--analyze", join(dir, "emulator.log"), join(dir, "results.jsonl")], { encoding: "utf8" });
    const failed = out.stdout.split("\n").filter((line) => line.startsWith("FAIL"));
    expect(out.status).toBe(1);
    // Every check that needs what the client received fails. (Some read only the log, and they still find what they look for.)
    for (const what of ["a call that works", "an expected failure", "a thrown exception", "invalid input", "the timeout guard answers 504", "an HTTP function"]) {
      expect(failed.some((line) => line.includes(what)), what).toBe(true);
    }
  });
});
