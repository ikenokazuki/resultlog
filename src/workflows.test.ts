import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", ".github", "workflows");
const workflows = Object.fromEntries(
  readdirSync(dir)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => [file, readFileSync(join(dir, file), "utf8")]),
);

/** The jobs of a workflow, by name, each as its own text (comments above a job belong to the job before it, which is harmless here). */
function jobsOf(text: string): Map<string, string> {
  const jobs = new Map<string, string>();
  let name = "";
  for (const line of (text.split(/^jobs:\s*$/m)[1] ?? "").split("\n")) {
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      name = header[1] as string;
      jobs.set(name, "");
    } else if (name) jobs.set(name, `${jobs.get(name)}${line}\n`);
  }
  return jobs;
}

/** What is wrong with a workflow, by the rules this repository sets itself for supply-chain safety. */
function problems(file: string, text: string): string[] {
  const found: string[] = [];
  for (const [, ref] of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    if (!/@[0-9a-f]{40}$/.test(ref as string)) found.push(`${file}: ${ref} is not pinned to a commit`);
  }
  if (!/^permissions:/m.test(text)) found.push(`${file}: no permissions at the top, so the repository default applies`);
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("#") && /\bnpm publish\b/.test(line)) found.push(`${file}: "${line.trim()}" (releases are staged, never published directly)`);
  }
  for (const [job, body] of jobsOf(text)) {
    const at = `${file} / ${job}`;
    if (!/^ {4}permissions:/m.test(body)) found.push(`${at}: no permissions of its own`);
    if (/id-token:\s*write/.test(body) && /actions\/checkout|npm ci|\bbun\b/.test(body)) found.push(`${at}: has the id-token permission and runs repository code`);
    const install = body.indexOf("npm ci");
    if (install >= 0) {
      const guard = body.indexOf("setup-takumi-guard-npm@");
      const verify = body.indexOf("scripts/verify-guard.mjs");
      const lockfile = body.indexOf("scripts/check-lockfile.mjs");
      if (!(guard >= 0 && guard < verify && verify < lockfile && lockfile < install)) found.push(`${at}: npm ci without Takumi Guard set up, verified, and the lockfile checked before it`);
    }
    const global = body.indexOf("npm install");
    if (global >= 0 && !(body.indexOf("NPM_CONFIG_REGISTRY: https://npm.flatt.tech/") >= 0 && body.indexOf("NPM_CONFIG_REGISTRY: https://npm.flatt.tech/") < global)) {
      found.push(`${at}: npm install that does not go through Takumi Guard`);
    }
  }
  return found;
}

describe("the workflows", () => {
  for (const [file, text] of Object.entries(workflows)) {
    test(`${file}: actions are pinned, permissions are narrow, installs go through Takumi Guard, nothing is published directly`, () => {
      expect(problems(file, text)).toEqual([]);
    });
  }

  test("the rules catch what they are for", () => {
    const ci = workflows["ci.yml"] as string;
    const release = workflows["release.yml"] as string;
    expect(problems("x", ci.replace(/(actions\/checkout)@[0-9a-f]{40}/, "$1@v7")).join()).toContain("not pinned");
    expect(problems("x", ci.replace(/^permissions: \{\}\n/m, "")).join()).toContain("no permissions at the top");
    expect(problems("x", ci.replace("        run: node scripts/verify-guard.mjs\n", "        run: echo skipped\n")).join()).toContain("npm ci without Takumi Guard");
    expect(problems("x", ci.replaceAll("        run: node scripts/check-lockfile.mjs\n", "        run: echo skipped\n")).join()).toContain("npm ci without Takumi Guard");
    expect(problems("x", release.replace('npm stage publish "package/$TARBALL"', 'npm publish "package/$TARBALL"')).join()).toContain("never published directly");
    expect(problems("x", release.replace(/(  stage:[\s\S]*?steps:\n)/, "$1      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n")).join()).toContain("id-token permission and runs repository code");
    expect(problems("x", release.replace("NPM_CONFIG_REGISTRY: https://npm.flatt.tech/", "NPM_CONFIG_REGISTRY: https://registry.npmjs.org/")).join()).toContain("does not go through Takumi Guard");
  });

  test("release.yml: a v* tag builds and then stages, from the npm environment only, and a manual run stages nothing", () => {
    const release = workflows["release.yml"] as string;
    expect(release).toMatch(/push:\n\s+tags: \["v\*"\]/);
    const stage = jobsOf(release).get("stage") as string;
    expect(stage).toContain("needs: build");
    expect(stage).toContain("if: github.ref_type == 'tag'");
    expect(stage).toContain("environment: npm");
    expect(stage).toContain("npm stage publish");
    expect(stage).toContain("id-token: write");
    expect(jobsOf(release).get("build")).not.toMatch(/id-token:\s*write/);
  });
});
