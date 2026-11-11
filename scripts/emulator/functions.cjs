// The functions that `npm run emulator` runs in the real Firebase Functions emulator, against the packed resultlog.
// scripts/emulator-check.mjs copies this file into a scratch project as functions/index.js.
//
// What is NOT imported: neverthrow. `ok` and `err` come from resultlog, and neverthrow is installed along with it.
const { onCall, onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { z } = require("zod");
const { configure, defineError, err, logContext, ok, ResultAsync, retry, toExternalError, wrapCall, wrapRequest } = require("resultlog");

setGlobalOptions({ region: "us-central1", timeoutSeconds: 5 });
configure({ timeoutSeconds: 5, timeoutMarginMs: 500 });

class OrderNotFound extends defineError("OrderNotFound", { code: "not-found", publicMessage: "Order not found." }) {}
class NotSignedIn extends defineError("NotSignedIn", { code: "unauthenticated" }) {}

// A request to a function of this same emulator, by the host the caller used: no port is written down here.
const viaFetch = (request, status) => {
  const url = `http://${request.rawRequest.headers.host}/${process.env.GCLOUD_PROJECT}/us-central1/echoStatus?status=${status}`;
  return fetch(url).then((response) => response.text());
};

// Plain functions, not wrapped: a marker in the emulator's output between scenarios, and a server that answers any status.
exports.marker = onRequest((req, res) => {
  console.log(`MARKER:${req.query.name}`);
  res.send("ok");
});
exports.echoStatus = onRequest((req, res) => {
  res.status(Number(req.query.status ?? 200)).json({ ok: true });
});

exports.okCall = onCall(wrapCall((request) => ok({ hello: request.data?.name ?? "world" })));
exports.missing = onCall(wrapCall(() => err(new OrderNotFound("orders/o1 missing"))));
exports.thrown = onCall(
  wrapCall(() => {
    throw new TypeError("Cannot read properties of undefined (reading 'items')");
  }),
);
exports.plainError = onCall(wrapCall(() => err(new Error("a plain Error, returned from the handler"))));
exports.validated = onCall(wrapCall(z.object({ id: z.string() }), (request) => ok({ id: request.data.id })));
exports.denied = onCall(wrapCall((request) => (request.auth ? ok({ uid: request.auth.uid }) : err(new NotSignedIn("sign in first")))));
exports.audited = onCall(
  wrapCall(() => {
    logContext.audit("sensitive_read", { target: "orders/o1" });
    return ok(1);
  }),
);
exports.slow = onCall(
  wrapCall(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    return ok(1);
  }),
);

// Two requests to one endpoint inside one retry() attempt, and the first one failed (503): something inside retried.
exports.stacked = onCall(
  wrapCall((request) =>
    retry(() =>
      ResultAsync.fromPromise(
        (async () => {
          await viaFetch(request, 503);
          await viaFetch(request, 503);
          return 1;
        })(),
        (e) => toExternalError("self", e),
      ),
    ),
  ),
);
// The same two requests, both answered 200 (two prompts to one model endpoint, say): not a retry.
exports.twice = onCall(
  wrapCall((request) =>
    retry(() =>
      ResultAsync.fromPromise(
        (async () => {
          await viaFetch(request, 200);
          await viaFetch(request, 200);
          return 1;
        })(),
        (e) => toExternalError("self", e),
      ),
    ),
  ),
);

exports.plainHttp = onRequest(wrapRequest((req) => (req.query.fail ? err(new OrderNotFound("x")) : ok({ method: req.method, path: req.path }))));
