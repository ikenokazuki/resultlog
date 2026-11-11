// What `npm run emulator` checks, from the emulator's output and from what the client received. Every check has to find
// what it looks for: an entry, an answer. A scenario that left no trace is a failure, never a pass.
import { scenarios as called, TRACE_ID } from "./scenarios.mjs";

/** Groups the entries resultlog wrote by scenario: the driver prints a MARKER line before each one. */
export function readEntries(logText) {
  const grouped = {};
  let current;
  for (const line of logText.split("\n")) {
    const marker = line.match(/MARKER:(\w+)/);
    if (marker) {
      current = marker[1];
      grouped[current] = [];
      continue;
    }
    // The emulator prints what a function writes to stdout as a line that starts with `>`.
    const json = line.match(/^>\s+(\{.*\})\s*$/);
    if (json && current) {
      try {
        grouped[current].push(JSON.parse(json[1]));
      } catch {}
    }
  }
  return grouped;
}

const VERIFICATION = "callable-request-verification";
const isVerification = (entry) => entry["logging.googleapis.com/labels"]?.["firebase-log-type"] === VERIFICATION;

/** `results` is what the driver recorded, by scenario name: { status, body }. */
export function runChecks(entries, results) {
  const outcome = [];
  const check = (what, test) => {
    let ok = false;
    try {
      ok = test() === true;
    } catch {} // an entry or an answer that is not there
    outcome.push({ ok, what });
  };
  const ours = (name) => (entries[name] ?? []).filter((entry) => !isVerification(entry));
  const firebase = (name) => (entries[name] ?? []).filter(isVerification);
  const answer = (name) => ({ status: results[name].status, body: JSON.parse(results[name].body) });
  const callables = called.filter((s) => s.fn !== "plainHttp").map((s) => s.name);

  check("a call that works answers with its value and writes one INFO entry", () => {
    const [entry] = ours("okCall");
    return answer("okCall").status === 200 && answer("okCall").body.result.hello === "x" && ours("okCall").length === 1 && entry.severity === "INFO";
  });
  check("the trace of the request's header reaches the entry (Firebase's logger adds it)", () => {
    return ours("okCall")[0]["logging.googleapis.com/trace"] === `projects/demo-resultlog/traces/${TRACE_ID}`;
  });
  check("an expected failure: 404 with the error's reason and public message, and a WARNING", () => {
    const { status, body } = answer("missing");
    const [entry] = ours("missing");
    return status === 404 && body.error.details.reason === "OrderNotFound" && body.error.message === "Order not found." && entry.severity === "WARNING" && entry.errorName === "OrderNotFound";
  });
  check("a thrown exception: the client sees only INTERNAL; the entry is an ERROR under its own name, with the stack once", () => {
    const { status, body } = answer("thrown");
    const [entry] = ours("thrown");
    return (
      status === 500 &&
      body.error.status === "INTERNAL" &&
      body.error.details === undefined &&
      entry.severity === "ERROR" &&
      entry.errorName === "TypeError" &&
      String(entry.message).includes("\n    at ") &&
      entry.cause.stack === undefined
    );
  });
  check("a plain Error returned from the handler is an ERROR under its own name", () => {
    const [entry] = ours("plainError");
    return answer("plainError").status === 500 && entry.severity === "ERROR" && entry.errorName === "Error";
  });
  check("invalid input: 400 with zod's issues for the client, and a security event with the actor", () => {
    const { status, body } = answer("validatedBad");
    const [entry] = ours("validatedBad");
    return status === 400 && body.error.details.issues[0].path[0] === "id" && entry.securityEvent === "input_validation_fail" && entry.actor.userAgent === "emu-check/1.0";
  });
  check("not signed in: 401, authz_fail, and the address is the entry the trusted proxy added, not the one the client wrote first", () => {
    const [entry] = ours("deniedAnon");
    return (
      answer("deniedAnon").status === 401 &&
      entry.securityEvent === "authz_fail" &&
      entry.actor.ip === "203.0.113.9" &&
      entry.actor.forwardedFor === "192.0.2.99, 203.0.113.9" &&
      entry.httpRequest.remoteIp === "203.0.113.9"
    );
  });
  check("a signed-in call carries its uid", () => {
    return answer("deniedAuth").body.result.uid === "uid-RAW-1" && ours("deniedAuth")[0].authUid === "uid-RAW-1";
  });
  check("an audited call writes the audit entry at once and the final entry after it", () => {
    const [audit, final] = ours("audited");
    return ours("audited").length === 2 && audit.auditEvent === "sensitive_read" && audit.actor.uid === "uid-RAW-1" && final.auditEvents[0] === "sensitive_read";
  });
  check("the timeout guard answers 504, and the entry says DeadlineExceeded", () => {
    return answer("slow").status === 504 && ours("slow")[0].errorName === "DeadlineExceeded";
  });
  check("a retry that wraps a self-retrying call throws under the emulator, naming the request without its query", () => {
    const [entry] = ours("stacked");
    return answer("stacked").status === 500 && /sent again after it failed/.test(entry.message) && !entry.message.includes("status=");
  });
  check("two requests that both worked are not a retry, and the calls are summarized per host", () => {
    const [entry] = ours("twice");
    const hosts = Object.values(entry.external);
    return answer("twice").status === 200 && entry.severity === "INFO" && entry.retries === undefined && hosts.length === 1 && hosts[0].calls === 2 && hosts[0].statuses["200"] === 2;
  });
  check("an HTTP function: the status in httpRequest, for a value and for an error", () => {
    return answer("httpOk").status === 200 && ours("httpOk")[0].httpRequest.status === 200 && answer("httpFail").status === 404 && ours("httpFail")[0].httpRequest.status === 404;
  });
  check("Firebase writes a DEBUG entry of its own for every callable call, and none for an HTTP function (the README's Log cost section tells how to exclude it)", () => {
    return callables.every((name) => firebase(name).length === 1 && firebase(name)[0].severity === "DEBUG") && firebase("httpOk").length === 0;
  });
  return outcome;
}
