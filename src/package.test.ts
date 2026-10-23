import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("package.json, as npm will publish it", () => {
  test("bin paths carry no leading ./, which npm rewrites with a warning that says the script was removed", () => {
    for (const [name, target] of Object.entries<string>(pkg.bin)) expect(target, name).not.toStartWith("./");
  });

  test("it names its author and its GitHub repository in the form npm keeps as it is, and bugs agrees with it", () => {
    expect(pkg.author).toBeString();
    expect(pkg.author).not.toBe("");
    expect(pkg.repository).toEqual({ type: "git", url: expect.stringMatching(/^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/) });
    const repo = (pkg.repository.url as string).replace(/^git\+/, "").replace(/\.git$/, "");
    expect(pkg.bugs).toEqual({ url: `${repo}/issues` });
    expect(pkg.homepage).toBeUndefined(); // none on purpose: npm links the repository's README
  });

  test("it is publishable, and a publish from a laptop is refused unless ALLOW_LOCAL_PUBLISH=1 (releases are made in CI)", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.scripts.prepublishOnly).toBe("node scripts/publish-guard.mjs");
    const guard = (env: Record<string, string>) =>
      spawnSync("node", [join(root, "scripts", "publish-guard.mjs")], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
    const refused = guard({});
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("ALLOW_LOCAL_PUBLISH=1");
    expect(guard({ ALLOW_LOCAL_PUBLISH: "1" }).status).toBe(0);
    expect(guard({ GITHUB_ACTIONS: "true" }).status).toBe(0);
  });

  test("every file it lists (other than the build output) exists", () => {
    for (const entry of pkg.files as string[]) if (entry !== "dist") expect(existsSync(join(root, entry)), entry).toBe(true);
  });
});
