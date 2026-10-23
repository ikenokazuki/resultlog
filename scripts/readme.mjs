// Keeps the READMEs honest. The table of contents is the headings; every link inside the page lands on a heading; every API
// entry (a #### heading that ends in (function), (class), (method), (property) or (command)) has its signature or usage, its
// example and a link back to the top; and the pages given have the same shape (the same headings by level, the same API entries,
// the same code blocks by language), so that the English and the Japanese one say the same things.
// Usage: node scripts/readme.mjs [--check | --write] README.md [README.ja.md ...]
//   --check (default) prints the problems and exits 1 if there are any; --write rewrites the table of contents first.
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv.includes("--write") ? "write" : "check";
const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

/** GitHub's anchor for a heading: lower case, anything but letters, marks, numbers, "_", space and "-" removed, spaces to hyphens. */
export const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replaceAll(" ", "-");

const TOC_TITLE = /^(table of contents|目次)$/i;
const ENTRY = /\((function|class|method|property|command)\)$/;
const LABELS = { signature: /\*\*(Signature|Usage|シグネチャ|使い方):\*\*/, example: /\*\*(Example|例):\*\*/, top: /\[⬆️ / };

/** The headings (outside code blocks) with their line numbers, and the code blocks' languages in order. */
function scan(text) {
  const lines = text.split("\n");
  const headings = [];
  const fences = [];
  let inFence = false;
  lines.forEach((line, at) => {
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      if (!inFence) fences.push(fence[1] ?? "");
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) headings.push({ level: heading[1].length, text: heading[2].trim(), at });
  });
  return { lines, headings, fences };
}

const tocOf = (headings) =>
  headings
    .filter((h) => h.level >= 2 && h.level <= 4 && !TOC_TITLE.test(h.text))
    .map((h) => `${"  ".repeat(h.level - 2)}- [${h.text}](#${slug(h.text)})`);

/** Replaces the list under the table-of-contents heading. */
function rewriteToc(text) {
  const { lines, headings } = scan(text);
  const toc = headings.find((h) => h.level === 2 && TOC_TITLE.test(h.text));
  if (!toc) return text;
  const next = headings.find((h) => h.level <= 2 && h.at > toc.at);
  const end = next ? next.at : lines.length;
  return [...lines.slice(0, toc.at + 1), "", ...tocOf(headings), "", ...lines.slice(end)].join("\n");
}

function problemsOf(file, text) {
  const found = [];
  const { lines, headings } = scan(text);
  const toc = headings.find((h) => h.level === 2 && TOC_TITLE.test(h.text));
  if (!toc) found.push(`${file}: no table of contents`);
  else {
    const next = headings.find((h) => h.level <= 2 && h.at > toc.at);
    const have = lines.slice(toc.at + 1, next ? next.at : lines.length).filter((l) => l.trim() !== "");
    if (have.join("\n") !== tocOf(headings).join("\n")) found.push(`${file}: the table of contents is not the headings (run: node scripts/readme.mjs --write ${file})`);
  }
  const anchors = new Map();
  for (const h of headings) anchors.set(slug(h.text), (anchors.get(slug(h.text)) ?? 0) + 1);
  for (const [anchor, count] of anchors) if (count > 1) found.push(`${file}: ${count} headings have the anchor #${anchor}`);
  const prose = lines.join("\n").replace(/```[\s\S]*?```/g, "");
  for (const [, anchor] of prose.matchAll(/\]\(#([^)]+)\)/g)) if (!anchors.has(anchor)) found.push(`${file}: the link #${anchor} lands on no heading`);
  headings.forEach((h, i) => {
    if (h.level !== 4 || !ENTRY.test(h.text)) return;
    const end = headings[i + 1]?.at ?? lines.length;
    const body = lines.slice(h.at, end).join("\n");
    if (!LABELS.signature.test(body)) found.push(`${file}: ${h.text} has no signature or usage`);
    if (!LABELS.example.test(body)) found.push(`${file}: ${h.text} has no example`);
    if (!LABELS.top.test(body)) found.push(`${file}: ${h.text} has no link back to the top`);
  });
  return found;
}

function shapeOf(text) {
  const { headings, fences } = scan(text);
  return { levels: headings.map((h) => h.level).join(""), entries: headings.filter((h) => h.level === 4 && ENTRY.test(h.text)).map((h) => h.text), fences: fences.join(",") };
}

if (files.length === 0) {
  console.error("Usage: node scripts/readme.mjs [--check | --write] README.md [README.ja.md ...]");
  process.exit(2);
}
if (mode === "write") for (const file of files) writeFileSync(file, rewriteToc(readFileSync(file, "utf8")));

const problems = [];
const shapes = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  problems.push(...problemsOf(file, text));
  shapes.push([file, shapeOf(text)]);
}
const [first, ...rest] = shapes;
for (const [file, shape] of rest) {
  if (shape.levels !== first[1].levels) problems.push(`${file} and ${first[0]} differ in their headings: they should have the same ones, by level`);
  if (shape.entries.join("|") !== first[1].entries.join("|")) problems.push(`${file} and ${first[0]} differ in their API entries`);
  if (shape.fences !== first[1].fences) problems.push(`${file} and ${first[0]} differ in their code blocks: they should have the same ones, by language`);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
