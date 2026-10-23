import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/verify-guard.mjs installs the package that Takumi Guard blocks and expects a 403. Here `npm` is a stand-in
// that answers as each situation would.
const script = join(import.meta.dir, "..", "scripts", "verify-guard.mjs");
let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "resultlog-guard-"));
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
if [ "$1" = "config" ]; then echo "https://npm.flatt.tech/"; exit 0; fi
case "$STUB_MODE" in
  installed) echo "added 1 package"; exit 0 ;;
  blocked) echo "npm error code E403" >&2; echo "npm error 403 403 Forbidden - GET https://npm.flatt.tech/@panda-guard%2ftest-malicious" >&2; exit 1 ;;
  offline) echo "npm error code ENOTFOUND" >&2; echo "npm error network request failed" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
});

const verify = (mode: string) =>
  spawnSync("node", [script], { env: { PATH: `${bin}:${process.env.PATH}`, STUB_MODE: mode }, encoding: "utf8" });

describe("scripts/verify-guard.mjs", () => {
  test("passes when the blocked package is refused with 403", () => {
    const run = verify("blocked");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("blocked");
  });

  test("fails when the blocked package installs: the guard is not in the path", () => {
    const run = verify("installed");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not in the path");
  });

  test("fails when the answer is not a 403, because then nothing was verified", () => {
    const run = verify("offline");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("could not be verified");
  });
});
