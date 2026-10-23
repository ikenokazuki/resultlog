import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/readme.mjs keeps the two READMEs honest: the table of contents is the headings, every link inside the page
// lands on a heading, every API entry has its signature and example, and the English and Japanese pages have the same shape.
const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "readme.mjs");
const en = readFileSync(join(root, "README.md"), "utf8");
const ja = readFileSync(join(root, "README.ja.md"), "utf8");

function run(args: string[]) {
  const result = spawnSync("node", [script, ...args], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The two pages in a scratch directory, each changed by the function given for it. */
function pages(changeEn: (text: string) => string = (t) => t, changeJa: (text: string) => string = (t) => t) {
  const dir = mkdtempSync(join(tmpdir(), "resultlog-readme-"));
  writeFileSync(join(dir, "README.md"), changeEn(en));
  writeFileSync(join(dir, "README.ja.md"), changeJa(ja));
  return [join(dir, "README.md"), join(dir, "README.ja.md")] as const;
}

describe("the READMEs", () => {
  test("pass every check", () => {
    const result = run(["--check", join(root, "README.md"), join(root, "README.ja.md")]);
    expect(result.out).toBe("");
    expect(result.status).toBe(0);
  });

  test("a table of contents that is not the headings is caught, and --write fixes it", () => {
    const [a, b] = pages((t) => t.replace(/^- \[Installation\]\(#installation\)\n/m, ""));
    const stale = run(["--check", a, b]);
    expect(stale.status).toBe(1);
    expect(stale.out).toContain("table of contents");
    expect(run(["--write", a, b]).status).toBe(0);
    expect(run(["--check", a, b]).status).toBe(0);
  });

  test("a link inside the page that lands on no heading is caught", () => {
    const [a, b] = pages((t) => t.replace("](#wrapcall-function)", "](#wrapcall-fonction)"));
    const result = run(["--check", a, b]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("#wrapcall-fonction");
  });

  test("an API entry without an example is caught", () => {
    const [a, b] = pages((t) => t.replace(/\*\*Example:\*\*\n\n```ts\nimport \{ fallback \} from "resultlog";/, '**Examples:**\n\n```ts\nimport { fallback } from "resultlog";'));
    const result = run(["--check", a, b]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("fallback");
  });

  test("an English page and a Japanese page that differ in shape are caught", () => {
    const [a, b] = pages(undefined, (t) => t.replace(/^#### `fallback` \(function\)$/m, "#### `fallback` (function)\n\n#### `extra` (function)"));
    const result = run(["--check", a, b]);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/differ|same/);
  });

  test("there is no wording that says the package is not published", () => {
    for (const text of [en, ja]) expect(text).not.toMatch(/not on npm yet|until it is published|npm にはまだ|公開されるまで/i);
  });
});
