// What `npm run emulator` calls, in order: the function (see functions.cjs) and how to call it.
export const PROJECT = "demo-resultlog";
export const REGION = "us-central1";

export const TRACE_ID = "105445aa7843bc8bf206b12000100000";

export const scenarios = [
  { name: "okCall", fn: "okCall", data: { name: "x" }, trace: `${TRACE_ID}/1;o=1` },
  { name: "missing", fn: "missing" },
  { name: "thrown", fn: "thrown" },
  { name: "plainError", fn: "plainError" },
  { name: "validatedBad", fn: "validated", data: { id: 123 } },
  { name: "deniedAnon", fn: "denied" },
  { name: "deniedAuth", fn: "denied", auth: true },
  { name: "audited", fn: "audited", auth: true },
  { name: "slow", fn: "slow" },
  { name: "stacked", fn: "stacked" },
  { name: "twice", fn: "twice" },
  { name: "httpOk", fn: "plainHttp", method: "GET", query: "?x=1" },
  { name: "httpFail", fn: "plainHttp", method: "GET", query: "?fail=1" },
];
