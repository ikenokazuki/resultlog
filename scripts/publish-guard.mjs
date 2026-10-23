// Releases are made by .github/workflows/release.yml, which stages the package for an approval on npmjs.com.
// This stops a publish from a laptop by accident. The first release has to be made by hand (see AGENTS.md):
// that one sets ALLOW_LOCAL_PUBLISH=1.
if (process.env.GITHUB_ACTIONS !== "true" && process.env.ALLOW_LOCAL_PUBLISH !== "1") {
  console.error(
    "Refusing to publish from this machine: releases are made by the Release workflow (see AGENTS.md).\n" +
      "To publish by hand on purpose, set ALLOW_LOCAL_PUBLISH=1.",
  );
  process.exit(1);
}
