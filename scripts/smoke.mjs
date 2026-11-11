// Runs the built package on the Node that runs this script, since the unit tests run on Bun and production runs on Node:
// every entry point loads as ESM and as CJS (through the exports map, by the package's own name), a wrapped call writes
// the entry the README promises, and the command works. Needs `npm run build` first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, okAsync, errAsync, ResultAsync } from "neverthrow";

const require = createRequire(import.meta.url);

for (const entry of ["", "/client", "/testing", "/digest", "/monitoring"]) {
  const esm = await import(`resultlog${entry}`);
  const cjs = require(`resultlog${entry}`);
  const names = (module) => Object.keys(module).filter((name) => name !== "default" && name !== "module.exports").sort();
  assert.deepEqual(names(esm), names(cjs), `resultlog${entry}: the ESM and CJS builds export the same names`);
  assert.ok(names(esm).length > 0, `resultlog${entry} exports something`);
}

const { defineError, wrapCall } = await import("resultlog");
const { callableRequest, captureLogs } = await import("resultlog/testing");
const logs = captureLogs();
class NotFound extends defineError("NotFound", { code: "not-found", publicMessage: "Not found." }) {}

assert.deepEqual(await wrapCall(() => okAsync({ fine: true }))(callableRequest({}, { uid: "u1" })), { fine: true });
await assert.rejects(wrapCall(() => errAsync(new NotFound("x is missing")))(callableRequest({}, { uid: "u1" })), { code: "not-found", message: "Not found." });

const [success, warning] = logs.entries;
assert.match(String(success?.message), /ok \d+ ms$/);
assert.equal(success?.severity, "INFO");
assert.equal(success?.authUid, "u1");
assert.equal(success?.httpRequest?.status, 200);
assert.equal(warning?.severity, "WARNING");
assert.equal(warning?.errorName, "NotFound");
assert.equal(warning?.httpRequest?.status, 404);

// Real requests. The unit tests publish the diagnostics_channel messages by hand, and Bun, which they run on, does not
// send them for the http module, so this is where fetch and the http module are what sends them, on every Node the
// package supports. A change in the messages Node sends would otherwise go unseen.
const { retry, toExternalError } = await import("resultlog");
const server = http.createServer((req, res) => {
  res.statusCode = Number(new URL(req.url, "http://localhost").searchParams.get("status") ?? 200);
  res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const host = `127.0.0.1:${server.address().port}`;
const viaFetch = async (path) => void (await (await fetch(`http://${host}${path}`)).text());
const viaHttp = (path) => new Promise((resolve, reject) => http.get(`http://${host}${path}`, (res) => res.resume().on("end", resolve)).on("error", reject));
const lastEntry = () => logs.entries.at(-1);

logs.clear();
await wrapCall(async () => {
  await viaFetch("/a?status=200");
  await viaHttp("/b?status=503");
  return ok(1);
})(callableRequest({}, { uid: "u1" }));
assert.equal(lastEntry().external[host].calls, 2, "both fetch and the http module are summarized");
assert.deepEqual(lastEntry().external[host].statuses, { 200: 1, 503: 1 });
assert.ok(!JSON.stringify(lastEntry()).includes("status="), "the query string is never logged");

const nodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production"; // a retry that stacks is recorded here; under tests and the emulator it throws
for (const [name, send] of [["fetch", viaFetch], ["http", viaHttp]]) {
  const attempt = (paths) =>
    wrapCall(() =>
      retry(() =>
        ResultAsync.fromPromise(
          (async () => {
            for (const path of paths) await send(path);
            return 1;
          })(),
          (e) => toExternalError("local", e),
        ),
      ),
    )(callableRequest({}, { uid: "u1" }));

  logs.clear();
  await attempt(["/flaky?status=503", "/flaky?status=503"]);
  const repeated = lastEntry().retries?.[0]?.repeatedRequest;
  assert.equal(repeated?.count, 2, `${name}: a request sent again after a 503 is noticed`);
  assert.match(repeated?.request ?? "", /^GET http:\/\/127\.0\.0\.1(:\d+)?\/flaky$/, `${name}: and logged without its query string`);

  logs.clear();
  await attempt(["/same?status=200", "/same?status=200"]);
  assert.equal(lastEntry().retries, undefined, `${name}: two requests that both worked are not a retry`);
}
if (nodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = nodeEnv;
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

const cli =(...args) => spawnSync(process.execPath, [join("dist", "esm", "cli.js"), ...args], { encoding: "utf8" });
assert.equal(cli("--help").status, 0);
const out = mkdtempSync(join(tmpdir(), "resultlog-smoke-"));
try {
  assert.equal(cli("monitoring", "--project", "demo-project-1", "--out", out).status, 0);
  assert.ok(readdirSync(out).includes("README.md"));
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`smoke ok on Node ${process.versions.node}`);
