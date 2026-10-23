import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "check-lockfile.mjs");

const lockOf = (resolved: Record<string, string | undefined>) =>
  `${JSON.stringify(
    {
      name: "x",
      lockfileVersion: 3,
      packages: {
        "": { name: "x" },
        ...Object.fromEntries(Object.entries(resolved).map(([name, url]) => [`node_modules/${name}`, { version: "1.0.0", resolved: url, integrity: `sha512-${name}` }])),
      },
    },
    null,
    2,
  )}\n`;

function check(contents: string | null) {
  const file = join(mkdtempSync(join(tmpdir(), "resultlog-lock-")), "package-lock.json");
  if (contents !== null) writeFileSync(file, contents);
  const result = spawnSync("node", [script, file], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, after: contents === null ? null : readFileSync(file, "utf8") };
}

// With the registry configured as Takumi Guard, npm sends an entry recorded with registry.npmjs.org to the guard first (its
// replace-registry-host default), and so it does an entry recorded with the guard. An entry from any other host (a git
// or tarball URL) is downloaded from there, past the guard: that is what this refuses.
describe("scripts/check-lockfile.mjs", () => {
  test("accepts entries from registry.npmjs.org and from Takumi Guard, and leaves the file alone", () => {
    const lock = lockOf({ a: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", b: "https://npm.flatt.tech/b/-/b-1.0.0.tgz" });
    const result = check(lock);
    expect(result.status).toBe(0);
    expect(result.after).toBe(lock);
  });

  test("refuses an entry from anywhere else, and says which", () => {
    const result = check(lockOf({ a: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", evil: "https://example.com/evil-1.0.0.tgz", viaGit: "git+ssh://git@github.com/o/r.git#abc" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node_modules/evil");
    expect(result.stderr).toContain("node_modules/viaGit");
    expect(result.stderr).not.toContain("node_modules/a ");
  });

  test("ignores entries without a URL (the root, links)", () => {
    expect(check(lockOf({ a: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", linked: undefined })).status).toBe(0);
  });

  test("fails when there is no lockfile, because then nothing was checked", () => {
    const result = check(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package-lock.json");
  });
});
