// Calls each scenario against the running Functions emulator and records what the client received.
// `npm run emulator` has the emulator run this: node drive.mjs <results.jsonl> <port>
import { appendFileSync, writeFileSync } from "node:fs";
import { PROJECT, REGION, scenarios } from "./scenarios.mjs";

const [out, port] = process.argv.slice(2);
writeFileSync(out, "");
const base = `http://127.0.0.1:${port}/${PROJECT}/${REGION}`;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
// The emulator does not verify the signature of an ID token, so an unsigned one signs a user in.
const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({
  sub: "uid-RAW-1",
  user_id: "uid-RAW-1",
  aud: PROJECT,
  iss: `https://securetoken.google.com/${PROJECT}`,
  iat: now,
  exp: now + 3600,
  auth_time: now,
  firebase: { sign_in_provider: "password", identities: {} },
})}.`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const s of scenarios) {
  await fetch(`${base}/marker?name=${s.name}`).then((r) => r.text());
  await sleep(200);
  const method = s.method ?? "POST";
  const headers = {
    "user-agent": "emu-check/1.0",
    "x-forwarded-for": "192.0.2.99, 203.0.113.9", // the client wrote the first one; the last is the one the trusted proxy adds
    ...(method === "POST" ? { "content-type": "application/json" } : {}),
    ...(s.auth ? { authorization: `Bearer ${token}` } : {}),
    ...(s.trace ? { "x-cloud-trace-context": s.trace } : {}),
  };
  const started = Date.now();
  const res = await fetch(`${base}/${s.fn}${s.query ?? ""}`, { method, headers, body: method === "POST" ? JSON.stringify({ data: s.data ?? {} }) : undefined });
  const body = await res.text();
  appendFileSync(out, `${JSON.stringify({ name: s.name, status: res.status, ms: Date.now() - started, body: body.slice(0, 400) })}\n`);
  await sleep(400); // the entry travels from the worker to the emulator's output a moment after the answer
}
await fetch(`${base}/marker?name=END`).then((r) => r.text());
await sleep(300);
