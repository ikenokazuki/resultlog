// Runs the built package on the Node that runs this script, since the unit tests run on Bun and production runs on Node:
// every entry point loads as ESM and as CJS (through the exports map, by the package's own name), a wrapped call writes
// the entry the README promises, and the command works. Needs `npm run build` first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync, errAsync } from "neverthrow";

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

const cli = (...args) => spawnSync(process.execPath, [join("dist", "esm", "cli.js"), ...args], { encoding: "utf8" });
assert.equal(cli("--help").status, 0);
const out = mkdtempSync(join(tmpdir(), "resultlog-smoke-"));
try {
  assert.equal(cli("monitoring", "--project", "demo-project-1", "--out", out).status, 0);
  assert.ok(readdirSync(out).includes("README.md"));
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`smoke ok on Node ${process.versions.node}`);
