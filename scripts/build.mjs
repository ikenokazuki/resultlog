// Builds dist/esm and dist/cjs, each with its own package.json so that Node and TypeScript read the right format.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
for (const [config, type] of [["tsconfig.esm.json", "module"], ["tsconfig.cjs.json", "commonjs"]]) {
  execFileSync("npx", ["tsc", "-p", config], { stdio: "inherit" });
  const dir = config.includes("esm") ? "dist/esm" : "dist/cjs";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, `${JSON.stringify({ type })}\n`);
}
