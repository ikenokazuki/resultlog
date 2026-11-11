import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "cli.ts");
const run = (args: string[], input?: string) => spawnSync("bun", [cli, ...args], { encoding: "utf8", input });

// Twelve refusals by one actor within two minutes: above the default threshold of authz-probing (10), below 20.
const refusal = (n: number) => ({
  severity: "WARNING",
  message: "authz_fail",
  securityEvent: "authz_fail",
  actor: { uid: "mallory", ip: "203.0.113.5" },
  timestamp: new Date(Date.UTC(2026, 9, 22, 10, 0, n * 10)).toISOString(),
});
const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify(refusal(i))).join("\n");
const scratch = mkdtempSync(join(tmpdir(), "resultlog-cli-"));
const file = join(scratch, "logs.jsonl");
writeFileSync(file, lines);

const json = (args: string[]) => {
  const result = run(["digest", file, ...args]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { entries: number; findings: unknown[]; failures: unknown[]; security: { audit: unknown[] } };
};

describe("resultlog digest", () => {
  test("reads a file, or standard input, and prints Markdown", () => {
    for (const result of [run(["digest", file]), run(["digest"], lines)]) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("# resultlog digest");
      expect(result.stdout).toContain("authz-probing");
    }
  });

  // Every common CLI takes both, so a user who writes --format=json is not told that the option does not exist.
  test.each([
    ["--format json", ["--format", "json"]],
    ["--format=json", ["--format=json"]],
  ])("takes %s", (_name, args) => {
    expect(json(args)).toMatchObject({ entries: 12 });
  });

  test.each([
    ["--threshold authz-probing=20", ["--threshold", "authz-probing=20"]],
    ["--threshold=authz-probing=20", ["--threshold=authz-probing=20"]],
  ])("takes %s, which raises one rule's threshold", (_name, args) => {
    expect(json(["--format", "json"]).findings).toHaveLength(1);
    expect(json(["--format", "json", ...args]).findings).toHaveLength(0);
  });

  test("takes --max-chars=N and --top=N", () => {
    const result = run(["digest", file, "--max-chars=400", "--top=1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(400);
  });

  test("--pseudonymize needs no value", () => {
    const result = run(["digest", file, "--pseudonymize"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("mallory");
  });

  test.each([
    ["an option it does not know", ["--bogus"]],
    ["an option without its value", ["--top"]],
    ["a number that is not one", ["--top=abc"]],
    ["a format it cannot print", ["--format=xml"]],
    ["a threshold without a number", ["--threshold=authz-probing"]],
    ["a second file", ["other.jsonl"]],
  ])("refuses %s, with status 2 and the usage", (_name, args) => {
    const result = run(["digest", file, ...args]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("resultlog digest [file] [options]");
    expect(result.stdout).toBe("");
  });

  test("asks for help with -h", () => {
    const result = run(["digest", "-h"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("resultlog digest [file] [options]");
  });
});

describe("resultlog monitoring", () => {
  test("takes --name=value as well", () => {
    const out = join(scratch, "monitoring-out");
    const result = run(["monitoring", "--project=my-project-123", `--out=${out}`, "--service=checkout,on-order", "--threshold=errors=9"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(out, "README.md"))).toBe(true);
  });

  test("refuses an option it does not know", () => {
    const result = run(["monitoring", "--project=my-project-123", "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("resultlog monitoring --project PROJECT");
  });
});
