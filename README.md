# resultlog

[![CI](https://github.com/ikenokazuki/resultlog/actions/workflows/ci.yml/badge.svg)](https://github.com/ikenokazuki/resultlog/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/resultlog)](https://www.npmjs.com/package/resultlog)
[![license](https://img.shields.io/npm/l/resultlog)](LICENSE)

Encode every Firebase Function invocation as one record.

[日本語](README.ja.md)

## Description

Return a [neverthrow](https://github.com/supermacro/neverthrow) `Result` from your Firebase Functions (v2) handlers and get, for every invocation:

- **one structured log entry** (a "wide event") holding everything you attached along the way,
- **errors that keep their stack trace and cause**, sent to Cloud Error Reporting only when they are server-side failures,
- **debug breadcrumbs that are written only when the invocation fails**,
- **zod-validated input**, with `request.data` / `req.body` typed from the schema,
- **an audit trail and security events** for investigating unauthorized access, ready to keep alongside GCP's Admin Activity audit logs,
- **one error model for external APIs**: Stripe, OpenAI / Anthropic / Gemini, Firestore and other gRPC clients, fetch and axios,
- **Cloud Logging cost controls**: sampling of successful runs and a size cap per entry,
- **retries that never stack** on an SDK's or library's own retries, detected even for SDKs it has never heard of,
- **a timeout guard** that writes the entry and answers before the platform kills a slow invocation, and hands you an `AbortSignal` to stop the calls in flight,
- **duplicate-event protection** for the at-least-once delivery of event triggers,
- **secrets redacted by pattern** (API keys, JWTs, card numbers) as well as by key name,
- **a summary of outgoing HTTP calls** per host (count, status, time), and a `coldStart` flag,
- **LLM call accounting**: tokens, model, finish reason and time to the first chunk, read from the response of any SDK, with no provider tables, and a cost from your own price function,
- **tools for working with AI**: a `fingerprint` that names each kind of failure, `resultlog digest` to turn a day of logs into a report small enough to hand to an AI assistant, test helpers that let a test assert on what a handler logged, and an `llms.txt` for AI coding assistants,
- **a small client helper** that turns a failed call into messages per form field,
- **detection of unauthorized access**: security events named after the OWASP Logging Vocabulary (declared on errors, or recorded with `logContext.security`), App Check state and replay detection, sign-in events from Identity Platform blocking functions, an optional `actor` on every entry, and detection rules in the digest,
- **alerts for changes made to the project itself**: Firebase Security Rules, IAM policies, service account keys, and Firebase or API key settings, from the Admin Activity audit log that Google always writes,
- **Cloud Monitoring setup**: log-based metrics, alert policies and a dashboard generated for what resultlog writes, as files for `gcloud` (`resultlog monitoring`).

## Why

Projects that combine Firebase Functions with a Result type tend to rebuild the same things:

1. **Lost stack traces.** `err("not found")` or `err({ type: "NOT_FOUND" })` records no stack, so logs and Error Reporting can't tell you where the failure came from.
2. **Error routing.** Every handler re-decides which errors are warnings, which ones page someone, which ones to retry, and what the client is allowed to see.
3. **Log noise versus missing context.** Successful requests emit many INFO lines (which you pay for), yet when something fails, the DEBUG lines you need were never written.
4. **Investigations.** After a suspected breach, you need to know who did what, from where, and whether it worked. Ordinary logs rarely record that consistently.
5. **Every API fails differently.** Stripe, AI providers, gRPC and fetch each report failures in their own shape, so retry and alert rules end up scattered.

## Table of contents

- [Description](#description)
- [Why](#why)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Top-Level API](#top-level-api)
- [API Documentation](#api-documentation)
  - [Handler adapters](#handler-adapters)
    - [`wrapCall` (function)](#wrapcall-function)
    - [`wrapRequest` (function)](#wraprequest-function)
    - [`wrapEvent` (function)](#wrapevent-function)
    - [`wrapBlocking` (function)](#wrapblocking-function)
  - [Errors](#errors)
    - [`defineError` (function)](#defineerror-function)
    - [`AppError` (class)](#apperror-class)
    - [`InvalidInput` (class)](#invalidinput-class)
    - [`DeadlineExceeded` (class)](#deadlineexceeded-class)
  - [Calling other services](#calling-other-services)
    - [`toExternalError` (function)](#toexternalerror-function)
    - [`ExternalError` (class)](#externalerror-class)
    - [`retry` (function)](#retry-function)
    - [`fallback` (function)](#fallback-function)
  - [Logging inside a handler](#logging-inside-a-handler)
    - [`logContext.set` (method)](#logcontextset-method)
    - [`logContext.debug` (method)](#logcontextdebug-method)
    - [`logContext.error` (method)](#logcontexterror-method)
    - [`logContext.audit` (method)](#logcontextaudit-method)
    - [`logContext.security` (method)](#logcontextsecurity-method)
    - [`logContext.setActor` (method)](#logcontextsetactor-method)
    - [`logContext.llm` (method)](#logcontextllm-method)
    - [`logContext.signal` (property)](#logcontextsignal-property)
  - [Configuration](#configuration)
    - [`configure` (function)](#configure-function)
  - [Idempotency](#idempotency)
    - [`firestoreIdempotency` (function)](#firestoreidempotency-function)
  - [Utilities](#utilities)
    - [`fingerprint` (function)](#fingerprint-function)
  - [Testing](#testing)
    - [`captureLogs` (function)](#capturelogs-function)
    - [`callableRequest` (function)](#callablerequest-function)
    - [`httpExchange` (function)](#httpexchange-function)
    - [`cloudEvent` (function)](#cloudevent-function)
    - [`authBlockingEvent` (function)](#authblockingevent-function)
  - [In the app](#in-the-app)
    - [`parseError` (function)](#parseerror-function)
    - [`parseErrorBody` (function)](#parseerrorbody-function)
  - [Digest](#digest)
    - [`parseLogs` (function)](#parselogs-function)
    - [`digest` (function)](#digest-function)
  - [Cloud Monitoring files](#cloud-monitoring-files)
    - [`monitoring` (function)](#monitoring-function)
    - [`files` (function)](#files-function)
  - [Command line](#command-line)
    - [`resultlog digest` (command)](#resultlog-digest-command)
    - [`resultlog monitoring` (command)](#resultlog-monitoring-command)
- [Timeouts](#timeouts)
- [What gets logged](#what-gets-logged)
  - [Made to be read in Cloud Logging](#made-to-be-read-in-cloud-logging)
- [External APIs](#external-apis)
- [Duplicate events](#duplicate-events)
- [Retries](#retries)
  - [Retries never stack](#retries-never-stack)
- [Outgoing calls](#outgoing-calls)
- [LLM calls](#llm-calls)
- [Security audit and investigation](#security-audit-and-investigation)
  - [Keep your audit trail with the Admin Activity audit logs](#keep-your-audit-trail-with-the-admin-activity-audit-logs)
- [Detecting unauthorized access](#detecting-unauthorized-access)
  - [What your functions can and cannot see](#what-your-functions-can-and-cannot-see)
  - [What gets recorded](#what-gets-recorded)
  - [Who made the call](#who-made-the-call)
  - [Sign-ins: wrapBlocking](#sign-ins-wrapblocking)
  - [Alerts](#alerts)
  - [When something is found](#when-something-is-found)
  - [What resultlog does not do](#what-resultlog-does-not-do)
- [Cloud Monitoring](#cloud-monitoring)
  - [By hand, in the console](#by-hand-in-the-console)
  - [Or have the files written for you](#or-have-the-files-written-for-you)
  - [What you get](#what-you-get)
  - [Changes made to the project itself](#changes-made-to-the-project-itself)
  - [Applying it](#applying-it)
  - [Things to know](#things-to-know)
- [Investigating with an AI assistant](#investigating-with-an-ai-assistant)
- [Log cost](#log-cost)
- [Redaction](#redaction)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Installation

```sh
npm install resultlog neverthrow
```

`neverthrow`, `firebase-functions` and `firebase-admin` are peer dependencies; a Functions project already has the last two, and npm installs the ones that are missing. `zod` is optional (see below).

It ships as ESM and CommonJS with type declarations, and works with `module: nodenext` (the Firebase default), `bundler` and the older `node` resolution.

Requirements (a typical Functions project has most of them already):

- Node.js 20+
- `firebase-functions` 6 or 7 (the v2 API) and `firebase-admin`
- `neverthrow` 8
- `zod` 4: optional, needed only for the types of the schemas you pass
- TypeScript 5.4 or later

The test suite passes against firebase-functions 7.4, 6.6 and 6.0, and against the lowest versions the peer ranges allow (firebase-admin 11.10, firebase-functions 6.0, neverthrow 8.0, zod 4.0). The type declarations need firebase-functions 7 unless `skipLibCheck` is on, because 6 doesn't export `Response` or `CallableResponse` from `firebase-functions/v2/https`.

Entry points: `resultlog` (the server side), `resultlog/client` (for the app: no server-side imports), `resultlog/testing`, `resultlog/digest`, `resultlog/monitoring`, and the `resultlog` command (`digest` and `monitoring`).

## Quick start

```ts
import { getFirestore } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { err, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import { defineError, logContext, wrapCall } from "resultlog";

class UserNotFound extends defineError("UserNotFound", { code: "not-found", publicMessage: "User not found." }) {}
class DbError extends defineError("DbError", { code: "internal" }) {} // ERROR severity; the client only sees "INTERNAL"

const findUser = (id: string) =>
  ResultAsync.fromPromise(getFirestore().doc(`users/${id}`).get(), (cause) =>
    new DbError("users read failed", { cause, context: { id } }),
  )
    .andThen((snap) => (snap.exists ? ok(snap.data()!) : err(new UserNotFound(`users/${id} does not exist`))))
    .andTee((user) => logContext.set({ plan: user.plan }));

export const getUser = onCall(
  wrapCall(z.object({ id: z.string() }), (request) => {
    logContext.debug("looking up user", { id: request.data.id });
    return findUser(request.data.id);
  }),
);
```

That is the whole setup. For this function:

- A request that finds the user returns the value and writes one entry: `{ "severity": "INFO", "message": "getuser ok 42 ms", "authUid": "u1", "plan": "pro", "httpRequest": { … } }`.
- An unknown id is a WARNING (`not-found`) and sends no alert. The client is told "User not found." and `details.reason: "UserNotFound"`.
- A Firestore failure is an ERROR with its stack and cause, reported to Error Reporting. The client sees only `INTERNAL`.
- An invalid `id` is rejected before the handler runs, and the client gets zod's issues to show per field.

See [What gets logged](#what-gets-logged) for the entries themselves, and the [API Documentation](#api-documentation) for everything else.

## Top-Level API

resultlog exposes the following. The first group is `resultlog` itself, for the server; the others are separate entry points.

**`resultlog`**

- [`wrapCall`](#wrapcall-function), [`wrapRequest`](#wraprequest-function), [`wrapEvent`](#wrapevent-function) and [`wrapBlocking`](#wrapblocking-function) turn a handler that returns a `Result` into one a Firebase trigger accepts, and write the invocation's one log entry
- [`defineError`](#defineerror-function) and [`AppError`](#apperror-class) make errors that keep their stack and know how to be logged, shown to the client and retried; [`InvalidInput`](#invalidinput-class) and [`DeadlineExceeded`](#deadlineexceeded-class) are the two the library raises itself
- [`toExternalError`](#toexternalerror-function) and [`ExternalError`](#externalerror-class) turn any upstream failure (Stripe, an AI provider, Firestore, fetch, axios) into one error model
- [`retry`](#retry-function) and [`fallback`](#fallback-function) retry a call or try another provider, without stacking on retries that are already there
- [`logContext`](#logging-inside-a-handler) adds to the invocation's entry: [`set`](#logcontextset-method), [`debug`](#logcontextdebug-method), [`error`](#logcontexterror-method), [`audit`](#logcontextaudit-method), [`security`](#logcontextsecurity-method), [`setActor`](#logcontextsetactor-method), [`llm`](#logcontextllm-method) and [`signal`](#logcontextsignal-property)
- [`configure`](#configure-function) sets sampling, the timeout, redaction, the LLM price function, the actor policy and the sink
- [`firestoreIdempotency`](#firestoreidempotency-function) keeps an event trigger from running twice for one event
- [`fingerprint`](#fingerprint-function) names a kind of failure

**`resultlog/testing`**: [`captureLogs`](#capturelogs-function), [`callableRequest`](#callablerequest-function), [`httpExchange`](#httpexchange-function), [`cloudEvent`](#cloudevent-function), [`authBlockingEvent`](#authblockingevent-function)

**`resultlog/client`**: [`parseError`](#parseerror-function), [`parseErrorBody`](#parseerrorbody-function)

**`resultlog/digest`**: [`digest`](#digest-function), [`parseLogs`](#parselogs-function)

**`resultlog/monitoring`**: [`monitoring`](#monitoring-function), [`files`](#files-function)

**Command line**: [`resultlog digest`](#resultlog-digest-command), [`resultlog monitoring`](#resultlog-monitoring-command)

[⬆️ Back to top](#table-of-contents)

---

## API Documentation

Every example assumes the imports it needs are at the top of the file; the [Quick start](#quick-start) shows them in one place. `Outcome<T>` stands for what a handler may return: a `Result<T, AppError>`, a `ResultAsync<T, AppError>` or a `Promise<Result<T, AppError>>`.

### Handler adapters

Wrap the handler, then pass it to the trigger as usual. Each adapter runs the handler inside the invocation's context, applies the [timeout guard](#timeouts) when you configured one, and turns the final `Result` into one log entry and an answer for the caller.

| Adapter | Use with | Starting attributes | Ok | Err (WARNING) | Err (ERROR / CRITICAL) |
|---|---|---|---|---|---|
| `wrapCall([schema,] fn, options?)` | `onCall` | `authUid`, `httpRequest` | value returned to the client | throws `HttpsError(code, publicMessage, details)` | throws `HttpsError(code, publicMessage)`, no details |
| `wrapRequest([schema,] fn, options?)` | `onRequest` | `httpRequest` (method, path) | `200` with the value as JSON | HTTP status for the code, body `{ error: { status, message, details } }` | same, without `details` |
| `wrapEvent(fn, options?)` | Pub/Sub, Firestore, Scheduler, … | `eventId`, `eventType` | — | logged and acknowledged, unless the error is `retryable` | logged and rethrown (retried when retries are enabled), unless `retryable: false` |
| `wrapBlocking(fn, options?)` | `beforeUserSignedIn`, `beforeUserCreated` | `eventId`, `eventType` | returned to Firebase (custom claims, …); an audit event `authn_login_success` (`user_created` for a sign-up) | throws `HttpsError`; the security event `authn_login_fail` | same, unless `failOpen: true` lets the sign-in through |

**Handler options.** Every adapter takes them as its last argument:

```ts
interface HandlerOptions {
  /** Cut the invocation off this long after it started, minus the margin. Without it (and without configure({ timeoutSeconds })) there is no guard. */
  timeoutSeconds?: number;
  /** How long before the timeout the guard steps in. Default 1000. */
  timeoutMarginMs?: number;
}
```

**Thrown exceptions** are logged as ERROR with code `internal`, keeping the original stack. A thrown `HttpsError` keeps its code and details, so an existing handler can be wrapped without changing what its clients receive.

#### `wrapCall` (function)

For `onCall`. An `Ok` value goes back to the client. An `Err` becomes an `HttpsError` with the error's `code` and `publicMessage`, and, for WARNING errors, `details` that carry `reason` (the error's name) so the app can tell apart errors that share a code. With a zod schema, `request.data` is parsed with `safeParseAsync` before `fn` runs, and its type comes from the schema.

**Signature:**

```ts
function wrapCall<T>(
  fn: (request: CallableRequest<unknown>, response?: CallableResponse) => Outcome<T>,
  options?: HandlerOptions,
): (request: CallableRequest, response?: CallableResponse) => Promise<T>;

function wrapCall<S extends ZodType, T>(
  schema: S,
  fn: (request: CallableRequest<output<S>>, response?: CallableResponse) => Outcome<T>,
  options?: HandlerOptions,
): (request: CallableRequest<input<S>>, response?: CallableResponse) => Promise<T>;
```

**Example:**

```ts
import { onCall } from "firebase-functions/v2/https";
import { err, ok } from "neverthrow";
import { z } from "zod";
import { defineError, wrapCall } from "resultlog";

class SoldOut extends defineError("SoldOut", { code: "failed-precondition", publicMessage: "Sold out." }) {}

export const reserve = onCall(
  wrapCall(z.object({ sku: z.string(), quantity: z.number().int().positive() }), (request) =>
    request.data.quantity > 5 //     ^ typed from the schema
      ? err(new SoldOut(`only 5 of ${request.data.sku} left`))
      : ok({ reserved: request.data.quantity }),
  ),
);
```

- Invalid input becomes an [`InvalidInput`](#invalidinput-class) error (`invalid-argument`, WARNING) and `fn` is not called. zod's `issues` go to the log and to the client as `details.issues`, so a form can show a message per field ([`parseError`](#parseerror-function) turns them into `fieldErrors`). Without a schema, `request.data` is `unknown`.
- Firebase client SDKs send `undefined` properties as `null`, so declare optional fields with `.nullish()`, not `.optional()`.
- `response` is `onCall`'s streaming response: `(request, response) => { response?.sendChunk(part); … }`.
- The entry starts with `authUid`, the caller's `actor` (see [Who made the call](#who-made-the-call)) and an `httpRequest` with the status the client receives.

[⬆️ Back to top](#table-of-contents)

---

#### `wrapRequest` (function)

For `onRequest`. An `Ok` value is sent as `200` JSON. An `Err` is sent with the HTTP status of its code and a body shaped like a callable's error: `{ error: { status, message, details } }`. With a schema, `req.body` is parsed and typed. If the handler has already answered (`res.headersSent`), nothing more is sent, and the entry records the status it sent.

**Signature:**

```ts
function wrapRequest<T>(
  fn: (req: Request, res: Response) => Outcome<T>,
  options?: HandlerOptions,
): (req: Request, res: Response) => Promise<void>;

function wrapRequest<S extends ZodType, T>(
  schema: S,
  fn: (req: Request & { body: output<S> }, res: Response) => Outcome<T>,
  options?: HandlerOptions,
): (req: Request, res: Response) => Promise<void>;
```

**Example:**

```ts
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { wrapRequest } from "resultlog";

export const webhook = onRequest(
  wrapRequest(z.object({ id: z.string() }), (req) => processWebhook(req.body.id)),
);
```

- The client address, `X-Forwarded-For` and user agent are recorded as the `actor`. Add a uid you verified yourself with [`logContext.setActor`](#logcontextsetactor-method).
- The entry's `httpRequest` has the method, the path (never the query string, which can hold secrets), the status and the latency.

[⬆️ Back to top](#table-of-contents)

---

#### `wrapEvent` (function)

For event triggers: Pub/Sub, Firestore, Scheduler, Storage and the rest. A failure that is `retryable` is rethrown, so the platform retries the event (when retries are enabled); any other failure is logged and acknowledged. A `retryable` failure is a server-side one by default (see [`AppError`](#apperror-class)).

**Signature:**

```ts
function wrapEvent<E>(
  fn: (event: E) => Outcome<unknown>,
  options?: EventOptions,
): (event: E) => Promise<void>;

interface EventOptions extends HandlerOptions {
  /** Acknowledge (log as WARNING, skip `fn`) events whose CloudEvent `time` is older than this. */
  maxEventAgeMs?: number;
  /** Skip events that were processed already. See `firestoreIdempotency`. */
  idempotency?: IdempotencyStore;
  /** How long a claim blocks redeliveries. Default: the timeout plus 60 s (540 s without a configured timeout). */
  leaseMs?: number;
}
```

**Example:**

```ts
import type { CloudEvent } from "firebase-functions/v2";
import { type MessagePublishedData, onMessagePublished } from "firebase-functions/v2/pubsub";
import { wrapEvent } from "resultlog";

export const onOrder = onMessagePublished(
  "orders",
  wrapEvent((event: CloudEvent<MessagePublishedData>) => handleOrder(event.data.message.json), {
    maxEventAgeMs: 60 * 60 * 1000,
  }),
);
```

- The event type is not inferred through the generic trigger functions. Annotate it as above, or pass the trigger's type argument: `onMessagePublished<Order>("orders", wrapEvent((event) => …))`. Event payloads are not validated for you; parse them with zod inside the handler.
- `maxEventAgeMs` ends a retry storm: with retries enabled, Cloud Functions (2nd gen) keeps retrying a failing event for up to 24 hours. An event older than the limit is acknowledged without running `fn` and logged as an `EventTooOld` WARNING.
- `idempotency` makes the handler run once per event; see [`firestoreIdempotency`](#firestoreidempotency-function).

[⬆️ Back to top](#table-of-contents)

---

#### `wrapBlocking` (function)

For the Identity Platform blocking triggers `beforeUserSignedIn` and `beforeUserCreated`. Every sign-in that gets through is recorded as the audit event `authn_login_success` (a sign-up as `user_created`), with the address, the user agent and the sign-in method. Returning an `AppError` denies the sign-in: Firebase gets an `HttpsError`, and the log gets the security event `authn_login_fail` (or the `securityEvent` the error names). What `fn` returns on success goes back to Firebase: custom claims, `disabled`, and so on.

**Signature:**

```ts
function wrapBlocking<R = void>(
  fn: (event: AuthBlockingEvent) => Outcome<R>,
  options?: BlockingOptions,
): (event: AuthBlockingEvent) => Promise<R | undefined>;

interface BlockingOptions extends HandlerOptions {
  /** What to do when the policy itself breaks (an exception, a timeout). false, the default, denies the sign-in; true lets it through and logs the failure. A denial the policy returns on purpose is always honoured. */
  failOpen?: boolean;
}
```

**Example:**

```ts
import { beforeUserSignedIn } from "firebase-functions/v2/identity";
import { err, ok } from "neverthrow";
import { defineError, wrapBlocking } from "resultlog";

class BlockedAddress extends defineError("BlockedAddress", { code: "permission-denied", publicMessage: "Sign-in is not available." }) {}

export const onSignIn = beforeUserSignedIn(
  wrapBlocking((event) => (isDenied(event.ipAddress) ? err(new BlockedAddress("on the deny list")) : ok({ sessionClaims: { plan: "free" } }))),
);
```

- It needs the project to be upgraded to Firebase Authentication with Identity Platform. Firebase gives a blocking function 7 seconds, so the timeout guard defaults to 7 here whatever the global timeout is.
- It runs after the credentials were verified, so a wrong password never gets here: see [what your functions can and cannot see](#what-your-functions-can-and-cannot-see). In the Auth emulator the address and user agent are placeholders.

[⬆️ Back to top](#table-of-contents)

---

### Errors

An error that crosses the library is an `AppError`: it has a Firebase `code`, a message for the client, a severity that decides where it is reported, and whether a failed event should be retried. Define the ones you use as named classes. Return them (`err(new UserNotFound(…))`) instead of throwing them.

#### `defineError` (function)

Returns a subclass of `AppError` with defaults. Extend it with a named class, so that editor hovers and type errors say `UserNotFound` instead of an anonymous class.

**Signature:**

```ts
function defineError<N extends string>(
  name: N,
  defaults: Omit<AppErrorOptions, "context" | "cause">,
): new (message: string, options?: { context?: Record<string, unknown>; details?: Record<string, unknown>; cause?: unknown }) => AppError & { name: N };
```

**Example:**

```ts
import { AppError, defineError } from "resultlog";

class UserNotFound extends defineError("UserNotFound", { code: "not-found", publicMessage: "User not found." }) {}

const e = new UserNotFound("users/u9 does not exist", { cause, context: { id: "u9" } });
e instanceof UserNotFound; // true
e instanceof AppError;     // true
e.name;                    // "UserNotFound" (a literal type, so unions of errors can be narrowed by name)
```

- `message` is internal: it goes to the logs only.
- `publicMessage` is the client's message. It defaults to the canonical status name, such as `"NOT_FOUND"`, so an internal message never reaches the client by accident.
- For WARNING errors the client also gets `details`: `{ reason: "UserNotFound", …your details }`. `reason` lets the app tell apart errors that share a code (two kinds of `already-exists`, for example) and pick its own translated text. `details` is public, so never put secrets in it. ERROR and CRITICAL errors give the client nothing beyond `publicMessage`.

[⬆️ Back to top](#table-of-contents)

---

#### `AppError` (class)

The base class. Use it directly for a one-off error; use [`defineError`](#defineerror-function) for the ones you meet again.

**Signature:**

```ts
class AppError extends Error {
  constructor(message: string, options: AppErrorOptions);
  readonly code: ErrorCode;           // a Firebase code such as "not-found"; never "ok"
  readonly severity: Severity;        // "WARNING" | "ERROR" | "CRITICAL"
  readonly retryable: boolean;
  readonly publicMessage: string;
  readonly context: Record<string, unknown>;
  readonly details?: Record<string, unknown>;
  readonly securityEvent?: string | false;
  withContext(extra: Record<string, unknown>): this; // adds fields to `context`, and returns the same error
}

interface AppErrorOptions {
  code: ErrorCode;
  publicMessage?: string;
  severity?: Severity;
  retryable?: boolean;
  securityEvent?: string | false;
  context?: Record<string, unknown>;
  details?: Record<string, unknown>;
  cause?: unknown;
}
```

**Example:**

```ts
import { AppError } from "resultlog";

const e = new AppError("the ledger is out of balance", {
  code: "data-loss",
  context: { ledger: "L-7" }, // goes to the log, never to the client
  cause: original,            // keeps the stack of what went wrong underneath
});
e.severity;      // "ERROR"
e.retryable;     // true
e.publicMessage; // "DATA_LOSS"
```

- `severity` defaults to `"ERROR"` when the code maps to an HTTP 5xx status (`internal`, `unknown`, `data-loss`, `unimplemented`, `unavailable`, `deadline-exceeded`) and to `"WARNING"` otherwise. ERROR and CRITICAL go to Error Reporting; WARNING doesn't.
- `retryable` decides whether [`wrapEvent`](#wrapevent-function) rethrows a failed event so that it is retried. It defaults to `severity !== "WARNING"`. Set it when the two differ: a rate limit isn't worth an alert but is worth a retry, and a bug in your code is worth an alert but retrying won't fix it.
- `securityEvent` records the failure as a security event whatever the client is told, with the actor: an [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html) name such as `authz_fail`. It lets you answer a request for someone else's order with `not-found`, which doesn't reveal that the order exists, and still see the attempt. Without it, `permission-denied` and `unauthenticated` count as `authz_fail`; `securityEvent: false` turns that off.
- `context` is merged into the log entry's top level. `error.withContext({ orderId })` adds to it while an error bubbles up through your layers. Errors you throw keep their stack; the stack of the `cause` is logged too.

[⬆️ Back to top](#table-of-contents)

---

#### `InvalidInput` (class)

Raised by the adapters when a zod schema rejects the input: `invalid-argument`, WARNING, and the security event `input_validation_fail` (so that the digest can see someone fuzzing an endpoint). Its `details.issues` are zod's issues, which the app turns into a message per form field with [`parseError`](#parseerror-function). Construct it yourself for a check you do by hand.

**Signature:**

```ts
class InvalidInput extends AppError {} // code: "invalid-argument", securityEvent: "input_validation_fail"
```

**Example:**

```ts
import { err, ok } from "neverthrow";
import { InvalidInput } from "resultlog";

// a check a schema can't express
const checkRange = (from: Date, to: Date) =>
  to > from
    ? ok({ from, to })
    : err(new InvalidInput("the end is before the start", { details: { issues: [{ path: ["to"], message: "Must be after the start" }] } }));
```

In a test, what the app would receive:

```ts
await expect(reserve(callableRequest({ sku: 1 }, { uid: "u1" }))).rejects.toMatchObject({
  code: "invalid-argument",
  details: { reason: "InvalidInput", issues: [{ path: ["sku"] }] },
});
```

[⬆️ Back to top](#table-of-contents)

---

#### `DeadlineExceeded` (class)

The error the [timeout guard](#timeouts) ends an invocation with, a little before the platform would kill it. `deadline-exceeded`, ERROR, retryable. The entry that carries it has everything gathered up to that moment.

**Signature:**

```ts
class DeadlineExceeded extends AppError {} // code: "deadline-exceeded", severity: "ERROR"
```

**Example:**

```ts
import { configure, logContext } from "resultlog";

configure({ timeoutSeconds: 60 }); // the same number you gave setGlobalOptions

// Stop the calls that can be stopped when the guard fires:
const res = await fetch(url, { signal: logContext.signal });
```

[⬆️ Back to top](#table-of-contents)

---

### Calling other services

#### `toExternalError` (function)

Turns any upstream failure into an [`ExternalError`](#externalerror-class). It reads the shape of the error, so it needs no SDK: a timeout, a network failure, an HTTP status, a gRPC code. It adds a small `upstream` summary to the log (`status`, `code`, `type`, `requestId`, `retryAfterMs`) and keeps large error objects, such as axios's request, out of it. The table of what becomes what is in [External APIs](#external-apis).

**Signature:**

```ts
function toExternalError<P extends string>(
  provider: P,
  error: unknown,
  classify?: (error: unknown, upstream: Upstream) => ExternalClassification | undefined,
): ExternalError<P>;

type ExternalClassification = Partial<Pick<AppErrorOptions, "code" | "severity" | "retryable" | "publicMessage" | "details" | "context">>;
```

**Example:**

```ts
import { ResultAsync } from "neverthrow";
import { toExternalError } from "resultlog";

const createIntent = (params: Stripe.PaymentIntentCreateParams) =>
  ResultAsync.fromPromise(stripe.paymentIntents.create(params), (e) =>
    toExternalError("stripe", e, (_error, upstream) =>
      upstream.type === "StripeCardError" ? { code: "failed-precondition", publicMessage: "Your card was declined." } : undefined,
    ),
  );
```

`classify` is for errors that mean something specific to one provider; whatever it returns overrides the defaults. For a `fetch` that resolved with a non-ok `Response`, pass the `Response` as is: `toExternalError("partner", res)`.

[⬆️ Back to top](#table-of-contents)

---

#### `ExternalError` (class)

What `toExternalError` returns: an `AppError` that remembers who failed and how.

**Signature:**

```ts
class ExternalError<P extends string = string> extends AppError {
  readonly provider: P;
  readonly upstream: Upstream;
}

interface Upstream {
  status?: number;
  code?: string | number;
  type?: string;
  requestId?: string;    // quote it to the provider's support
  retryAfterMs?: number; // from Retry-After, when the provider sent one
}
```

**Example:**

```ts
const result = await createIntent(params);
if (result.isErr()) {
  const { provider, upstream, retryable } = result.error;
  // "stripe", { status: 429, requestId: "req_…", retryAfterMs: 2000 }, true
}
```

The provider name is a type parameter, so `retry()` can refuse, at compile time, to wrap a call whose SDK already retries (see [Retries never stack](#retries-never-stack)).

[⬆️ Back to top](#table-of-contents)

---

#### `retry` (function)

Runs a call again when it fails with a `retryable` error, and returns a `ResultAsync` like the call itself. It waits as long as `Retry-After` says when the provider sends one, and otherwise uses a jittered exponential backoff. Use it only for idempotent calls.

**Signature:**

```ts
function retry<T, E extends AppError, const O extends RetryOptions = {}>(
  fn: () => Outcome<T, E>, // its type also carries the compile-time guard: see "Retries never stack"
  options?: O,
): ResultAsync<T, E>;

interface RetryOptions {
  attempts?: number;                // in total, the first one included. Default 3
  baseDelayMs?: number;             // upper bound of the first backoff; it doubles. Default 200
  maxDelayMs?: number;              // longest single wait; a longer Retry-After stops retrying. Default 2000
  budgetMs?: number;                // stop when the next wait would end this long after the first attempt started. Default 5000
  sdkRetriesDisabled?: boolean;     // you set the SDK's own retries to 0
  allowRepeatedRequests?: boolean;  // the call repeats the same request on purpose (polling)
}
```

**Example:**

```ts
import { retry } from "resultlog";

const getPartner = (url: string) => retry(() => fetchPartner(url), { attempts: 3, budgetMs: 3000 });
```

- It never stacks on another retry layer. For Stripe, OpenAI and Anthropic it is a type error unless you turned the SDK's retries off and pass `sdkRetriesDisabled: true`; for any other call it notices at run time that one attempt sent the same HTTP request twice, and stops. Read [Retries never stack](#retries-never-stack).
- It knows the [timeout guard](#timeouts)'s deadline: it doesn't wait past it.
- Each `retry()` that retried, or wanted to and stopped, is recorded in the entry as `retries`.

[⬆️ Back to top](#table-of-contents)

---

#### `fallback` (function)

Tries the attempts in turn, and moves on only when the failure is `retryable`, meaning the provider is at fault: a request that is itself wrong would be refused by the next provider too. Each attempt it leaves is recorded under `handledErrors` with the attempt's index.

**Signature:**

```ts
function fallback<const A extends readonly [() => Outcome<any>, ...(() => Outcome<any>)[]]>(
  ...attempts: A
): ResultAsync<OutcomeOk<A[number]>, OutcomeErr<A[number]>>;
```

**Example:**

```ts
import { fallback } from "resultlog";

const answer = (prompt: string) =>
  fallback(
    () => askPrimary(prompt),   // each returns a ResultAsync<Answer, ExternalError>
    () => askSecondary(prompt), // tried only if the first failed in a way worth another provider
  );
```

[⬆️ Back to top](#table-of-contents)

---

### Logging inside a handler

Do not log inside a handler with `console.log` or `firebase-functions/logger`: add facts to the invocation's one entry with `logContext`. The context lives in `AsyncLocalStorage`, so concurrent invocations never mix. `set`, `debug`, `error` and `setActor` do nothing outside a wrapped handler; `audit` and `security` write even there.

#### `logContext.set` (method)

Adds fields to the invocation's single log entry. It pairs well with `andTee`.

**Signature:**

```ts
logContext.set(attrs: Record<string, unknown>): void;
```

**Example:**

```ts
import { logContext } from "resultlog";

findUser(id).andTee((user) => logContext.set({ plan: user.plan, region: user.region }));
// → { "severity": "INFO", "message": "getuser ok 42 ms", "plan": "pro", "region": "eu", … }
```

Values go through [redaction](#redaction): a key such as `password` or `token`, and anything that looks like an API key, a JWT or a card number, is replaced. A field named like one resultlog writes itself (`errorName`, `durationMs`, …) is replaced by the library's: see [Limitations](#limitations).

[⬆️ Back to top](#table-of-contents)

---

#### `logContext.debug` (method)

Keeps a breadcrumb in memory (the latest 50). Breadcrumbs are written, as `breadcrumbs`, **only if the invocation fails**: the detail you need when something breaks, without paying to log it when nothing does.

**Signature:**

```ts
logContext.debug(message: string, data?: Record<string, unknown>): void;
```

**Example:**

```ts
logContext.debug("looking up user", { id });
logContext.debug("cache miss", { key: `users/${id}` });
// on a failure: "breadcrumbs": [{ "timestamp": "…", "level": "DEBUG", "message": "looking up user", "data": { "id": "u9" } }, …]
```

[⬆️ Back to top](#table-of-contents)

---

#### `logContext.error` (method)

Records an error you recovered from (a cache miss you fell back from, say) under `handledErrors`. The invocation still succeeds, and such a run is never sampled away. It pairs with `orElse`.

**Signature:**

```ts
logContext.error(error: unknown, data?: Record<string, unknown>): void;
```

**Example:**

```ts
readFromCache(key).orElse((e) => {
  logContext.error(e, { step: "cache" });
  return readFromDb(key);
});
```

[⬆️ Back to top](#table-of-contents)

---

#### `logContext.audit` (method)

Writes an audit entry (NOTICE) **right away**, with the actor and the label `audit`, so it survives a timeout or a crash later in the invocation. The invocation's final entry lists the same events under `auditEvents`, with the outcome. It also works outside a wrapped handler. Use [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html) names where they fit: `authz_change`, `authz_admin`, `sensitive_read`, `sensitive_update`, `sensitive_delete`, `user_created`, `user_deleted`.

**Signature:**

```ts
logContext.audit(event: string, data?: Record<string, unknown>): void;
```

**Example:**

```ts
logContext.audit("authz_change", { target: `users/${id}`, role: "admin" });
```

```json
{
  "severity": "NOTICE",
  "message": "authz_change",
  "auditEvent": "authz_change",
  "target": "users/u9",
  "role": "admin",
  "actor": { "uid": "u1", "ip": "203.0.113.5", "userAgent": "Mozilla/5.0 …" },
  "logging.googleapis.com/labels": { "audit": "true" }
}
```

See [Security audit and investigation](#security-audit-and-investigation).

[⬆️ Back to top](#table-of-contents)

---

#### `logContext.security` (method)

Records a security event at once, with the actor and the label `security`. Use it where nothing fails but something deserves a trail, such as `sensitive_read`. To answer a request with a harmless error and still record it, declare `securityEvent` on the error instead; record an event one way or the other, not both.

**Signature:**

```ts
logContext.security(
  event: string,
  data?: Record<string, unknown>,
  options?: { severity?: "NOTICE" | "WARNING" | "ERROR" | "CRITICAL" }, // default "WARNING"
): void;
```

**Example:**

```ts
logContext.security("sensitive_read", { collection: "payments", count: rows.length });
logContext.security("authn_token_reuse", { appId }, { severity: "CRITICAL" });
```

See [Detecting unauthorized access](#detecting-unauthorized-access).

[⬆️ Back to top](#table-of-contents)

---

#### `logContext.setActor` (method)

Adds to the record of who made the request. `wrapCall` fills in the uid, the sign-in provider, App Check and the address by itself; in `onRequest` nothing is verified for you, so add the uid you checked.

**Signature:**

```ts
logContext.setActor(fields: Record<string, unknown>): void;
```

**Example:**

```ts
const decoded = await getAuth().verifyIdToken(token);
logContext.setActor({ uid: decoded.uid });
```

[⬆️ Back to top](#table-of-contents)

---

#### `logContext.llm` (method)

Records an LLM call: tokens, model and finish reason are read from the response of any SDK by what its keys say, with no table of providers. Given a stream, it returns the same chunks and also records the time to the first one and whether the stream was cut short. It returns what you gave it, so it fits inside a chain.

**Signature:**

```ts
logContext.llm<T>(response: T, explicit?: LlmCall): T;
logContext.llm<C>(stream: AsyncIterable<C>, explicit?: LlmCall): AsyncGenerator<C, void, undefined>;

interface LlmCall {
  model?: string;
  finishReason?: string;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

**Example:**

```ts
const completion = await client.chat.completions.create({ model: "gpt-4o-mini", messages });
logContext.llm(completion);

for await (const chunk of logContext.llm(stream)) send(chunk);

logContext.llm(response, { model: "my-alias", inputTokens: 1200 }); // what it can't read, you pass
```

How the numbers are read, what counts as cut off or withheld, and how to price a call: [LLM calls](#llm-calls).

[⬆️ Back to top](#table-of-contents)

---

#### `logContext.signal` (property)

An `AbortSignal` that aborts when the [timeout guard](#timeouts) is about to cut the invocation off. The handler itself can't be cancelled, so pass the signal to the calls that can stop. Undefined outside a wrapped handler.

**Signature:**

```ts
logContext.signal: AbortSignal | undefined;
```

**Example:**

```ts
const res = await fetch(url, { signal: logContext.signal });
const completion = await client.messages.create(params, { signal: logContext.signal });
```

[⬆️ Back to top](#table-of-contents)

---

### Configuration

#### `configure` (function)

Sets how the library behaves. Call it once at startup, before the first invocation. A later call changes only the options it names.

**Signature:**

```ts
function configure(options: LogOptions): void;

interface LogOptions {
  /** Share of fast successes that are logged, 0 to 1. Default 1. Failures, slow runs, audits and other notable runs are always logged. */
  successSampleRate?: number;
  /** A success at least this slow (ms) is always logged. Default 1000. */
  slowMs?: number;
  /** Your functions' timeout in seconds. The platform doesn't expose it. Turns the timeout guard on. */
  timeoutSeconds?: number;
  /** How long before the timeout the guard steps in (ms). Default 1000. */
  timeoutMarginMs?: number;
  /** Summarize the invocation's outgoing HTTP calls per host. Default true. */
  recordExternalCalls?: boolean;
  /** Patterns to redact besides the built-in ones; matches become "[REDACTED:custom]". */
  secretPatterns?: RegExp[];
  /** Prices one LLM call, in any unit; the sum is `llm.cost`. Return undefined for a call you can't price. */
  price?: (call: LlmCall) => number | undefined;
  /** "security" (default): the actor on audit and security entries. "all": on every entry. */
  actor?: "security" | "all";
  /** Receives every entry instead of the platform logger. A sink that throws is ignored. */
  sink?: (entry: LogEntry) => void;
}
```

**Example:**

```ts
import { setGlobalOptions } from "firebase-functions/v2";
import { configure } from "resultlog";

setGlobalOptions({ timeoutSeconds: 60 }); // the platform's setting
configure({
  timeoutSeconds: 60,       // the same number, for resultlog
  successSampleRate: 0.1,   // keep 10% of the fast successes
  slowMs: 1000,
  secretPatterns: [/internal-\d{6}/],
});
```

`sink` receives every entry instead of the platform logger: use it to send entries somewhere else, or to print them in local development. Where each option is explained: [Timeouts](#timeouts), [Log cost](#log-cost), [Redaction](#redaction), [LLM calls](#llm-calls) (`price`), [Who made the call](#who-made-the-call) (`actor`), and [Testing](#testing) (`sink`).

[⬆️ Back to top](#table-of-contents)

---

### Idempotency

#### `firestoreIdempotency` (function)

Event triggers deliver at least once. This makes a handler run once per event: the first delivery claims the event in a Firestore transaction, a redelivery finds it done and skips the handler (logging `duplicate: true`). How claims, failures and leases behave is in [Duplicate events](#duplicate-events).

**Signature:**

```ts
function firestoreIdempotency(
  db: Pick<Firestore, "collection" | "runTransaction">,
  options?: { collection?: string; ttlMs?: number }, // default "_resultlog_events" and 7 days
): IdempotencyStore;

interface IdempotencyStore {
  claim(key: string, leaseMs: number): Promise<"claimed" | "done" | "in-flight">;
  complete(key: string): Promise<void>;
  release(key: string): Promise<void>;
}
```

**Example:**

```ts
import { getFirestore } from "firebase-admin/firestore";
import type { CloudEvent } from "firebase-functions/v2";
import { type MessagePublishedData, onMessagePublished } from "firebase-functions/v2/pubsub";
import { firestoreIdempotency, wrapEvent } from "resultlog";

const idempotency = firestoreIdempotency(getFirestore());

export const onPayment = onMessagePublished("payments", wrapEvent((event: CloudEvent<MessagePublishedData>) => charge(event), { idempotency }));
```

Any other store works: implement `IdempotencyStore`.

[⬆️ Back to top](#table-of-contents)

---

### Utilities

#### `fingerprint` (function)

A 12-character hex id that names a kind of failure. Every failure entry carries one, so you can count, group and query by it (`jsonPayload.fingerprint="b49c01a8ca7b"`), and `resultlog digest` groups its report by it. It is built from the error's name and code, where it was raised (the function and file, not the line, so a deploy doesn't change it) and, for an upstream failure, the provider and the class of the status. The message is left out, because it holds ids.

**Signature:**

```ts
function fingerprint(error: AppError): string;
```

**Example:**

```ts
import { defineError, fingerprint } from "resultlog";

class UserNotFound extends defineError("UserNotFound", { code: "not-found" }) {}

const lookup = (id: string) => new UserNotFound(`users/${id} does not exist`);
fingerprint(lookup("u9")); // "b49c01a8ca7b"
fingerprint(lookup("u1")); // "b49c01a8ca7b": the same kind of failure
```

[⬆️ Back to top](#table-of-contents)

---

### Testing

`resultlog/testing` has what a test of a handler needs. Entries go to a sink you control, so a test can assert on what the handler logged. Call the wrapped handler itself (`const getUser = wrapCall(…)`), or `onCall(getUser).run(request)` to go through Firebase's own wrapper.

```ts
import { afterEach, expect, test } from "bun:test";
import { callableRequest, captureLogs } from "resultlog/testing";

const logs = captureLogs();
// getUser is the handler wrapCall returned, before onCall(…) wraps it for Firebase
afterEach(() => logs.clear());

test("an unknown user is a warning, and the client is told why", async () => {
  await expect(getUser(callableRequest({ id: "u9" }, { uid: "u1" }))).rejects.toMatchObject({
    code: "not-found",
    details: { reason: "UserNotFound" },
  });
  expect(logs.entries).toMatchObject([{ severity: "WARNING", errorName: "UserNotFound", authUid: "u1" }]);
});
```

#### `captureLogs` (function)

Collects the entries instead of printing them, by setting [`configure({ sink })`](#configure-function). `clear()` empties the list between tests; `restore()` puts the previous sink back. Without a sink, entries go to `firebase-functions/logger` as usual.

**Signature:**

```ts
function captureLogs(): CapturedLogs;

interface CapturedLogs {
  readonly entries: LogEntry[];
  clear(): void;
  restore(): void;
}
```

**Example:**

```ts
const logs = captureLogs();
await getUser(callableRequest({ id: "u1" }, { uid: "u1" }));
logs.entries[0]; // { severity: "INFO", message: "ok 3 ms", authUid: "u1", durationMs: 3, … } (the message starts with the function name where K_SERVICE is set)
logs.restore();
```

[⬆️ Back to top](#table-of-contents)

---

#### `callableRequest` (function)

Builds the request an `onCall` handler receives, with an `auth` for the uid you give (none without it), the address and a user agent, and, if you pass `app`, an App Check result.

**Signature:**

```ts
function callableRequest<T = unknown>(
  data?: T,
  options?: {
    uid?: string;
    token?: Record<string, unknown>; // the ID token's claims, e.g. { admin: true }
    ip?: string;                      // default "127.0.0.1"
    app?: { appId: string; alreadyConsumed?: boolean }; // alreadyConsumed: a replayed token
  },
): CallableRequest<T>;
```

**Example:**

```ts
const admin = callableRequest({ id: "u9" }, { uid: "u1", token: { admin: true } });
const replayed = callableRequest({}, { uid: "u1", app: { appId: "1:123:web:abc", alreadyConsumed: true } });
```

[⬆️ Back to top](#table-of-contents)

---

#### `httpExchange` (function)

Builds a request and a response for a `wrapRequest` handler. `sent` records the status and the body the handler answered.

**Signature:**

```ts
function httpExchange(options?: {
  method?: string;                    // default "GET"
  path?: string;                      // default "/"
  body?: unknown;
  headers?: Record<string, string>;
}): { req: Request; res: Response; sent: { status?: number; body?: unknown } };
```

**Example:**

```ts
const handler = wrapRequest((req) => ok({ received: req.body.id }));
const { req, res, sent } = httpExchange({ method: "POST", path: "/webhook", body: { id: "evt_1" } });
await handler(req, res);
sent; // { status: 200, body: { received: "evt_1" } }
```

[⬆️ Back to top](#table-of-contents)

---

#### `cloudEvent` (function)

Builds a CloudEvent for a `wrapEvent` handler, with the id and time a real trigger delivers.

**Signature:**

```ts
function cloudEvent<T>(data: T, options?: Partial<CloudEvent<T>>): CloudEvent<T>; // id, type, source, time
```

**Example:**

```ts
const handler = wrapEvent((event: CloudEvent<{ id: string }>) => processOrder(event.data.id));
await handler(cloudEvent({ id: "o1" }, { id: "evt-1" }));
await handler(cloudEvent({ id: "o1" }, { id: "evt-1" })); // the same id again: a redelivery
```

[⬆️ Back to top](#table-of-contents)

---

#### `authBlockingEvent` (function)

Builds the event a blocking function receives: a sign-in by default; use an `eventType` ending in `beforeCreate:<provider>` for a sign-up.

**Signature:**

```ts
function authBlockingEvent(options?: {
  uid?: string;
  ipAddress?: string;
  userAgent?: string;
  eventType?: string;
  eventId?: string;
}): AuthBlockingEvent;
```

**Example:**

```ts
const policy = wrapBlocking((event) => (isDenied(event.ipAddress) ? err(new BlockedAddress("on the deny list")) : ok()));
await expect(policy(authBlockingEvent({ ipAddress: "198.51.100.9" }))).rejects.toMatchObject({ code: "permission-denied" });
```

[⬆️ Back to top](#table-of-contents)

---

### In the app

`resultlog/client` turns a failed call into what a screen needs. It has no server-side imports, so it is safe in a browser bundle.

```ts
import { httpsCallable } from "firebase/functions";
import { parseError } from "resultlog/client";

try {
  await httpsCallable(functions, "createUser")(form);
} catch (e) {
  const error = parseError(e);
  if (error.reason === "EmailTaken") showMessage(t("emailTaken")); // pick the text by the error's name
  else if (Object.keys(error.fieldErrors).length > 0) showFieldErrors(error.fieldErrors); // zod issues, per field
  else if (error.retryable) showRetryButton();
  else showMessage(error.message);
}
```

#### `parseError` (function)

Reads the error a callable throws in the app (the Firebase JS SDK's `FunctionsError`) and returns a `ClientError`. It never throws, whatever it is given: anything that is not a callable's error, a network failure say, becomes `code: "unknown"` with its message.

**Signature:**

```ts
function parseError(error: unknown): ClientError;

interface ClientError {
  code: string;                           // the Firebase code without its "functions/" prefix
  reason?: string;                        // the error's name on the server, e.g. "EmailTaken" (WARNING errors from defineError)
  message: string;                        // the public message
  details: Record<string, unknown>;       // whatever else the server sent
  issues: ClientIssue[];                  // the zod issues of an InvalidInput
  fieldErrors: Record<string, string[]>;  // the same as messages per field: { "address.zip": ["Too small"] }; "_form" is the form as a whole
  retryable: boolean;                     // unavailable, deadline-exceeded, resource-exhausted, aborted
}

interface ClientIssue {
  path: (string | number)[];
  message: string;
  code?: string;
}
```

**Example:**

```ts
const error = parseError(e);
error.code;        // "invalid-argument"
error.fieldErrors; // { quantity: ["Number must be greater than 0"] }
```

`retryable` means the server may succeed on a later try. Retry automatically only what is safe to repeat.

[⬆️ Back to top](#table-of-contents)

---

#### `parseErrorBody` (function)

The same for a response from an `onRequest` function wrapped by `wrapRequest`: pass the parsed JSON body.

**Signature:**

```ts
function parseErrorBody(body: unknown): ClientError;
```

**Example:**

```ts
const response = await fetch("/api/orders", { method: "POST", body: JSON.stringify(form) });
if (!response.ok) {
  const error = parseErrorBody(await response.json());
  showMessage(error.message);
}
```

[⬆️ Back to top](#table-of-contents)

---

### Digest

`resultlog/digest` turns a day of Cloud Logging entries into a report small enough to hand to an AI assistant, and runs the detection rules over them. It is what [`resultlog digest`](#resultlog-digest-command) uses.

#### `parseLogs` (function)

Reads what `gcloud logging read --format=json` returns (a JSON array), or one JSON value per line, as a log export gives. Lines that are not JSON are counted, not fatal.

**Signature:**

```ts
function parseLogs(text: string): { logs: unknown[]; skipped: number };
```

**Example:**

```ts
import { readFileSync } from "node:fs";
import { parseLogs } from "resultlog/digest";

const { logs, skipped } = parseLogs(readFileSync("logs.json", "utf8"));
```

[⬆️ Back to top](#table-of-contents)

---

#### `digest` (function)

Returns the report as data and as Markdown: findings from the detection rules, failure groups by `fingerprint`, security events and their actors, slow or failing hosts, LLM usage, and reliability, with each sampled success counted at its weight. See [Investigating with an AI assistant](#investigating-with-an-ai-assistant) for what the report holds, and [Detecting unauthorized access](#detecting-unauthorized-access) for the rules.

**Signature:**

```ts
function digest(logs: unknown[], options?: DigestOptions): { data: Digest; markdown: string };

interface DigestOptions {
  top?: number;                         // items per list. Default 10
  maxChars?: number;                    // upper bound of the Markdown. Default 20000
  pseudonymize?: boolean;               // uids, addresses and user agents become stable pseudonyms
  admins?: string[];                    // uids allowed to change permissions and accounts
  thresholds?: Record<string, number>;  // change a rule's threshold: { "authz-probing": 5 }
  rules?: Rule[];                       // your own rules
}

interface Rule {
  name: string;
  severity: "info" | "low" | "medium" | "high";
  summary: string;
  hint: string;
  filter(probe: Probe): boolean;        // which entries count
  key(probe: Probe): string | undefined; // counted per key (an actor, an address)
  distinct?(probe: Probe): string | undefined; // count distinct values instead of entries
  threshold: number;
  windowMs?: number;
}
```

**Example:**

```ts
import { digest } from "resultlog/digest";

const { data, markdown } = digest(logs, {
  pseudonymize: true,
  admins: ["u1"],
  rules: [
    {
      name: "night-admin",
      severity: "medium",
      summary: "An administrative change was made at night.",
      hint: "Check with the admin that it was them.",
      filter: (p) => p.kind === "audit" && new Date(p.time ?? 0).getUTCHours() < 5,
      key: (p) => p.uid,
      threshold: 1,
    },
  ],
});
data.findings; // [{ rule: "night-admin", severity: "medium", subject: "u1", count: 1, … }]
```

[⬆️ Back to top](#table-of-contents)

---

### Cloud Monitoring files

`resultlog/monitoring` builds the log-based metrics, alert policies and dashboard of [Cloud Monitoring](#cloud-monitoring) as plain objects, and as the files that `gcloud` takes. It only produces data: it never talks to Google Cloud.

#### `monitoring` (function)

Returns the metrics, the alert policies and the dashboard as objects, so that a Terraform, Pulumi or CDK setup can build its resources from them.

**Signature:**

```ts
function monitoring(options: MonitoringOptions): { metrics: Record<string, LogMetric>; alerts: Record<string, AlertPolicy>; dashboard: Record<string, any> };

interface MonitoringOptions {
  project: string;                            // your Google Cloud project id
  prefix?: string;                            // names start with it. Default "resultlog"
  services?: string[];                        // cover only these functions, by Cloud Run service name (the function name in lower case)
  notificationChannels?: string[];            // "projects/PROJECT/notificationChannels/ID"
  thresholds?: Partial<Record<"errors" | "security-events" | "timeouts" | "llm-problems", number>>;
}
```

**Example:**

```ts
import { monitoring } from "resultlog/monitoring";

const { alerts } = monitoring({ project: "my-project", services: ["checkout"], thresholds: { errors: 10 } });
Object.keys(alerts); // ["server-errors", "security-events", "token-replay", …, "rules-changed", "iam-changed", …]
```

[⬆️ Back to top](#table-of-contents)

---

#### `files` (function)

Returns the file set that `resultlog monitoring` writes, by path: `metrics/*.json`, `alerts/*.json`, `dashboard.json` and a `README.md` that says which `gcloud` commands apply them.

**Signature:**

```ts
function files(options: MonitoringOptions): Record<string, string>;
```

**Example:**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { files } from "resultlog/monitoring";

for (const [path, content] of Object.entries(files({ project: "my-project" }))) {
  mkdirSync(dirname(join("monitoring", path)), { recursive: true });
  writeFileSync(join("monitoring", path), content);
}
```

[⬆️ Back to top](#table-of-contents)

---

### Command line

The package installs one command, `resultlog`.

#### `resultlog digest` (command)

Reads Cloud Logging entries (a JSON array, or one JSON value per line) from a file or from stdin, and prints the [digest](#digest-function).

**Usage:**

```sh
resultlog digest [file] [options]

  --format markdown|json   Output format (default markdown)
  --top N                  How many items to list per section (default 10)
  --max-chars N            Upper bound of the Markdown (default 20000)
  --pseudonymize           Replace uids, IP addresses and user agents with pseudonyms
  --admins uid1,uid2       Uids allowed to change permissions and accounts; a change by anyone else is a high finding
  --threshold rule=N       Change the threshold of a detection rule (repeatable)
```

**Example:**

```sh
gcloud logging read 'resource.type="cloud_run_revision"' --freshness=1d --limit=3000 --format=json \
  | npx resultlog digest --pseudonymize > digest.md
```

[⬆️ Back to top](#table-of-contents)

---

#### `resultlog monitoring` (command)

Writes the [Cloud Monitoring files](#files-function) into a directory. It only writes files and never talks to Google Cloud; the `README.md` it writes says which `gcloud` commands apply them.

**Usage:**

```sh
resultlog monitoring --project PROJECT [options]

  --project ID                  Your Google Cloud project id (required)
  --out DIR                     Where to write the files (default ./monitoring)
  --service a,b                 Cover only these functions, by Cloud Run service name
  --notification-channel NAME   Where alerts notify, projects/PROJECT/notificationChannels/ID (repeatable)
  --threshold name=N            errors, security-events, timeouts or llm-problems (repeatable)
  --prefix NAME                 Prefix of the names (default resultlog)
```

**Example:**

```sh
npx resultlog monitoring --project my-project \
  --notification-channel projects/my-project/notificationChannels/1234567890
```

[⬆️ Back to top](#table-of-contents)

---

## Timeouts

A function that runs out of time is killed by the platform: no final log entry, and an error the client can't interpret. Those are the invocations you most want to investigate. Tell resultlog your timeout and it steps in a little earlier instead:

```ts
setGlobalOptions({ timeoutSeconds: 60 }); // the platform's setting
configure({ timeoutSeconds: 60 });         // the same number, for resultlog: the platform doesn't expose it
```

- When `timeoutSeconds - timeoutMarginMs` (the margin is 1,000 ms by default) has passed, the invocation is cut off: the entry is written (`DeadlineExceeded`, ERROR, with everything gathered so far, including `external` and the breadcrumbs), and the client gets `deadline-exceeded`, an `onRequest` caller gets a `504`, and an event is rethrown so that the platform retries it.
- The handler itself can't be cancelled. `logContext.signal` is an `AbortSignal` that aborts at that moment, so pass it to the calls that can stop: `fetch(url, { signal: logContext.signal })`, or an SDK's `signal` option. This is also how you stop a long LLM call or an agent loop.
- `retry()` knows the deadline: it doesn't wait past it, and once it has passed it doesn't start another attempt.
- A different timeout for one function: `wrapCall(fn, { timeoutSeconds: 300 })`, `wrapRequest(fn, { timeoutSeconds: 300 })` and `wrapEvent(fn, { timeoutSeconds: 300 })`. Without `timeoutSeconds` there is no guard.
- For a function that is cut off, the entry is the only record of what it was doing. Whatever it still does in the background is not captured.

## What gets logged

Success:

```json
{
  "severity": "INFO",
  "message": "getuser ok 42 ms",
  "authUid": "u1",
  "plan": "pro",
  "httpRequest": { "requestMethod": "POST", "requestUrl": "/", "status": 200, "latency": "0.042s" },
  "durationMs": 42
}
```

Expected failure (WARNING):

```json
{
  "severity": "WARNING",
  "message": "users/u9 does not exist",
  "authUid": "u1",
  "httpRequest": { "requestMethod": "POST", "requestUrl": "/", "status": 404, "latency": "0.012s" },
  "errorName": "UserNotFound",
  "errorCode": "not-found",
  "fingerprint": "b49c01a8ca7b",
  "publicMessage": "User not found.",
  "retryable": false,
  "durationMs": 12,
  "breadcrumbs": [{ "timestamp": "2026-10-22T10:00:00.010Z", "level": "DEBUG", "message": "looking up user", "data": { "id": "u9" } }]
}
```

Server failure (ERROR), picked up by Error Reporting:

```json
{
  "severity": "ERROR",
  "message": "DbError: users read failed\n    at findUser (src/users.ts:12:5)\n    ...",
  "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
  "authUid": "u1",
  "id": "u9",
  "httpRequest": { "requestMethod": "POST", "requestUrl": "/", "status": 500, "latency": "5.003s" },
  "context": { "user": "u1", "httpRequest": { "method": "POST", "url": "/", "responseStatusCode": 500 } },
  "errorName": "DbError",
  "errorCode": "internal",
  "fingerprint": "be9d6ab16d29",
  "publicMessage": "INTERNAL",
  "retryable": true,
  "durationMs": 5003,
  "breadcrumbs": ["…"],
  "cause": { "name": "Error", "message": "4 DEADLINE_EXCEEDED: …", "stack": "…" }
}
```

### Made to be read in Cloud Logging

- **The message is a line you can scan.** A success reads `getuser ok 42 ms`: the function (Cloud Run's service name, from `K_SERVICE`; left out where there is none), the outcome and the time. A WARNING's message is the error's own message, and an ERROR's starts with the stack, because that is where Error Reporting reads it.
- **`httpRequest`.** The entry of a callable or an HTTP function carries Cloud Logging's `httpRequest` field: `requestMethod`, `requestUrl` (the path only, because a query string can hold secrets), `status` (what the client received: 200, or the HTTP status of the error's code) and `latency`. Logs Explorer knows the field, so you can filter on it, for example `httpRequest.status>=500`. `remoteIp` and `userAgent` are in it only where the actor is (audit and security entries, or every entry with `configure({ actor: "all" })`), and `remoteIp` only if it is a valid address, because a forged `X-Forwarded-For` can make `req.ip` anything; the actor keeps the raw value. Events and blocking functions answer no request, so their entries have no `httpRequest`.
- **Error Reporting's `context`.** ERROR and CRITICAL entries also carry `context.user` (the Firebase uid) and `context.httpRequest` (`method`, `url`, `responseStatusCode`, and `remoteIp` and `userAgent` by the same rule). These are the fields Error Reporting documents for the user and the request an error belongs to. Events have neither, so they get no `context`.

How Logs Explorer summarizes an entry that has `httpRequest`, and what Error Reporting shows from `context`, have not been checked against a live project.

## External APIs

`toExternalError(provider, error, classify?)` turns any upstream failure into an `ExternalError`. It reads the shape of the error, so it needs no SDK, and it adds a small `upstream` summary to the log: `status`, `code`, `type`, `requestId` (quote it to the provider's support) and `retryAfterMs`. Large error objects, such as axios's request, never reach the log.

```ts
const createIntent = (params: Stripe.PaymentIntentCreateParams) =>
  ResultAsync.fromPromise(stripe.paymentIntents.create(params), (e) => toExternalError("stripe", e));
```

| Upstream failure | code | severity | retryable |
|---|---|---|---|
| Timeout (`TimeoutError`, `AbortError`, `ETIMEDOUT`, HTTP 408 / 504) | `deadline-exceeded` | ERROR | yes |
| Network failure (`ECONNRESET`, `ENOTFOUND`, `fetch failed`, …) | `unavailable` | ERROR | yes |
| HTTP 429 | `resource-exhausted` | WARNING | yes |
| HTTP 5xx, including Anthropic's 529 "overloaded" | `unavailable` | ERROR | yes |
| Other HTTP 4xx, including 401 / 403 (check your API key and permissions) | `internal` | ERROR | no |
| gRPC status (Firestore and other Google Cloud clients) | the same code, except `invalid-argument`, `out-of-range`, `permission-denied` and `unauthenticated` become `internal` | by code | for `deadline-exceeded`, `resource-exhausted`, `aborted`, `internal` and `unavailable` |
| Anything else | `internal` | ERROR | yes |

The status comes from `status`, `statusCode` or `response.status` (axios). The request id comes from `requestId` (Stripe), `request_id` or `requestID` (OpenAI, Anthropic), or the `x-request-id` / `request-id` headers.

Use `classify` for errors that mean something specific to one provider. Whatever it returns overrides the defaults.

**Stripe.** A declined card is the customer's problem, not an incident:

```ts
const toStripeError = (e: unknown) =>
  toExternalError("stripe", e, (error, upstream) =>
    upstream.type === "StripeCardError"
      ? {
          code: "failed-precondition",
          publicMessage: "Your card was declined.",
          // Stripe advises a generic message for some decline codes, so keep the code in the log only.
          context: { declineCode: (error as { decline_code?: string }).decline_code },
        }
      : undefined,
  );
```

**Generative AI.** Rate limits, timeouts and "overloaded" errors are already retryable. Map the errors that are really about the user's input:

```ts
const toOpenAIError = (e: unknown) =>
  toExternalError("openai", e, (_error, upstream) =>
    upstream.code === "context_length_exceeded"
      ? { code: "invalid-argument", publicMessage: "The input is too long." }
      : undefined,
  );
```

**Firestore** needs no recipe: its gRPC codes map directly. `create()` on an existing document becomes `already-exists` (WARNING), and transaction contention (`aborted`) is retryable.

**fetch** doesn't reject on HTTP errors. Pass a non-ok `Response` as is:

```ts
const getPartner = (url: string) =>
  ResultAsync.fromPromise(fetch(url, { signal: AbortSignal.timeout(5000) }), (e) => toExternalError("partner", e))
    .andThen((res) => (res.ok ? ok(res) : err(toExternalError("partner", res))));
```

## Duplicate events

Event triggers deliver at least once: a retry, or the platform itself, can run your handler twice for one event. Where that would charge a card or call a paid API twice, let resultlog remember the events:

```ts
import { getFirestore } from "firebase-admin/firestore";
import type { CloudEvent } from "firebase-functions/v2";
import { type MessagePublishedData, onMessagePublished } from "firebase-functions/v2/pubsub";
import { firestoreIdempotency, wrapEvent } from "resultlog";

const events = firestoreIdempotency(getFirestore());

export const onOrder = onMessagePublished(
  "orders",
  wrapEvent((event: CloudEvent<MessagePublishedData>) => handle(event), { idempotency: events }),
);
```

- The first delivery **claims** the event (a document per function and event id, written in a transaction) and runs the handler. When the event is dealt with, which includes a failure that is acknowledged, the claim becomes `done`. Redeliveries then skip the handler and log `duplicate: true`.
- A failure that will be retried, or a thrown exception, **releases** the claim, so that the retry runs the handler again.
- A delivery that arrives while another instance holds a live claim is not skipped, because that instance may still crash. It is rethrown (`EventInFlight`, WARNING, retryable) and retried later. A claim lapses after `leaseMs`, which defaults to the timeout plus 60 s (540 s when no timeout is configured), so an instance that died doesn't block the event for good.
- An invocation that the timeout guard cuts off keeps its claim until the lease lapses, because its handler may still be running somewhere. The platform's retry meets `EventInFlight` and tries again later.
- If the store itself fails, the claim fails the invocation and the event is retried. A failure to mark an event `done` or to release it is only logged, under `handledErrors`.
- Each event costs a Firestore transaction and a write, plus a delete when the claim is released. Documents go to `_resultlog_events` (change it with `{ collection }`) and carry an `expireAt` timestamp. Let Firestore delete them with a TTL policy (not run here):

  ```bash
  gcloud firestore fields ttls update expireAt --collection-group=_resultlog_events --enable-ttl
  ```

- Any other store works: implement `IdempotencyStore` (`claim`, `complete`, `release`).
- This protects the handler, not what it calls. For a side effect that has to happen exactly once, also use the provider's idempotency key, derived from `event.id`.

## Retries

`retry(fn, options?)` runs a call again when it fails with a `retryable` error, and returns a `ResultAsync` like the call itself:

```ts
const getPartner = (url: string) => retry(() => fetchPartner(url), { attempts: 3, budgetMs: 3000 });
```

- It waits as long as `Retry-After` says when the provider sends one, and otherwise uses a jittered exponential backoff: from `baseDelayMs`, doubling, capped at `maxDelayMs`.
- It gives up after `attempts`, when the next wait would go past `budgetMs`, or when `Retry-After` is longer than `maxDelayMs`. A function has a timeout and a callable has a user waiting, so it fails fast instead of waiting long. For events, leave long waits to the platform's retries (`wrapEvent` rethrows).
- Each `retry()` that retried, or wanted to and stopped, is recorded in the wide event as `retries: [{ attempts, waitedMs, outcome, stoppedBy?, repeatedRequest? }]`, and every wait leaves a breadcrumb.
- Defaults: `attempts` 3, `baseDelayMs` 200, `maxDelayMs` 2000, `budgetMs` 5000.

Use `retry()` only for idempotent calls. Running a payment or an email again can duplicate it. Providers with idempotency keys, such as Stripe, handle that in their SDK's own retries.

### Retries never stack

Stacked retry layers multiply the calls to a provider that is already struggling: an SDK's 3 tries × `retry()`'s 3 × the platform's retries. `retry()` refuses to stack, in two ways.

**At compile time**, for SDKs known to retry by themselves: Stripe (1 retry by default since v13), OpenAI and Anthropic (2 by default). A call converted with `toExternalError("stripe", …)` can't be wrapped:

```ts
retry(createCharge);
// Type error: "stripe's SDK already retries this call. Set its own retries to 0 and pass { sdkRetriesDisabled: true }, or remove retry()."
retry(createCharge, { sdkRetriesDisabled: true }); // fine, with new Stripe(key, { maxNetworkRetries: 0 })
```

Add other providers with declaration merging:

```ts
declare module "resultlog" {
  interface SelfRetryingProviders {
    gemini: true;
  }
}
```

**At run time**, for any SDK or function, listed or not. `retry()` watches outgoing HTTP requests through Node's `diagnostics_channel`: those sent with fetch, and those sent with the `http` module, which axios and the Stripe SDK use. If one attempt sent the same request more than once, something inside has already retried: axios-retry, an SDK, or a nested `retry()`. `retry()` then stops instead of multiplying the calls, and records `stoppedBy: "internal-retry"` with the repeated request. In tests (`NODE_ENV=test`) and in the emulator (`FUNCTIONS_EMULATOR=true`) it throws instead, so you find out before production. The detection was checked with axios-retry and the Stripe and OpenAI SDKs on Node 26, and the channels it relies on with Node 20, 22 and 26.

The run-time check has limits:

- It sees retries that happened, not retries that could happen, so it fires only once the inner layer has actually retried.
- It doesn't see HTTP/2 requests (gRPC, so Firestore) or retries that involve no HTTP request.
- A call that repeats the same request on purpose, such as polling, looks like a retry. Pass `{ allowRepeatedRequests: true }`.
- Node marks its built-in channels as experimental.

## Outgoing calls

Every wide entry carries a summary of the HTTP calls the invocation made, per host. The calls are observed through Node's `diagnostics_channel`: those made with fetch, and those made with the `http` module, which axios and the Stripe SDK use.

```json
"external": {
  "api.anthropic.com": { "calls": 2, "statuses": { "200": 1, "529": 1 }, "totalMs": 5210, "maxMs": 4980 },
  "api.stripe.com": { "calls": 1, "statuses": { "200": 1 }, "totalMs": 310, "maxMs": 310 }
}
```

- `statuses` counts the responses by status, `errors` the calls that failed without a response (a timeout, a reset, an abort), and `pending` the calls that had not been answered when the invocation ended.
- `totalMs` and `maxMs` are the time until the response headers arrived. For a streamed response that is the time to the first byte, not to the end of the stream.
- Only the host is recorded, never the path or the query string. At most 20 hosts are listed. The platform's metadata server is left out.
- It answers "which call was slow?", "which provider is failing?" and "how many LLM calls did this request make?" (a count of calls to `api.openai.com` is a count of billable requests). In Logs Explorer, quote the host: `jsonPayload.external."api.openai.com".calls>2`.
- Not visible: gRPC (so Firestore), which uses HTTP/2, and anything that isn't HTTP. Turn the summary off with `configure({ recordExternalCalls: false })`.
- Each entry also carries `coldStart: true` when it is the first invocation of an instance, which separates slow starts from slow code. Cold starts are never sampled away.

## LLM calls

An LLM call is slow, billable and can fail without an error: the answer may be cut off, or withheld. Hand the response to `logContext.llm` and the entry records what the call used:

```ts
const completion = await client.chat.completions.create({ model: "gpt-4o-mini", messages });
logContext.llm(completion); // returns `completion`, so it also fits inside a chain: .andTee((res) => logContext.llm(res))
```

```json
"llm": {
  "calls": 2,
  "inputTokens": 1810, "outputTokens": 402, "totalTokens": 2212, "cachedTokens": 1200,
  "models": { "gpt-4o-mini": { "calls": 2, "inputTokens": 1810, "outputTokens": 402 } },
  "finishReasons": { "stop": 1, "length": 1 },
  "truncated": 1,
  "ttftMs": 640,
  "cost": 0.00054
}
```

**Nothing here is a table of providers or models.** resultlog reads a response by what its keys say: a number whose key names a token count and says `input` or `prompt` is the input tokens, `output`, `completion` or `candidates` the output tokens, `cache` the cached ones (`creat…` / `writ…` the cache writes), `reason…` or `thought…` the reasoning ones. A `usage` object (or `usageMetadata`) is looked for near the top of the response, and so are a `model` (also `modelId`, `modelVersion`) and a `finish_reason` / `stop_reason` / `finishReason`. The first match wins. It was checked against the response shapes of OpenAI (chat completions and responses), Anthropic, Gemini, the Vercel AI SDK, Bedrock Converse and Cohere, and an SDK that follows the same vocabulary works without any change.

- **Numbers are recorded as the provider reports them.** OpenAI counts cached tokens inside the input tokens, Anthropic next to them. resultlog doesn't reconcile that.
- **What it can't read, you pass.** `logContext.llm(response, { model: "my-alias", inputTokens: 1200 })`; what you pass wins. A call it could read nothing from is counted under `unrecognized`, so a response shape it doesn't know shows up in the log instead of being silently missed.
- **Cut-off and withheld answers.** A finish reason about running out of room (`length`, `max_tokens`) counts under `truncated`, and one about filtering, safety or refusal (`content_filter`, `SAFETY`, `refusal`) under `blocked`. These are bad answers that arrive with a `200`, so no error is raised. Such runs are never sampled away.
- **Cost comes from your own function.** There is no price list, because prices change and yours may differ. Give `configure` a function that prices one call, in whatever unit you like, and return undefined for a call you can't price:

  ```ts
  const PER_MILLION = { "gpt-4o-mini": [0.15, 0.6] } as const; // yours to maintain
  configure({
    price: ({ model = "", inputTokens = 0, outputTokens = 0 }) => {
      const rates = PER_MILLION[model as keyof typeof PER_MILLION];
      return rates && (inputTokens * rates[0] + outputTokens * rates[1]) / 1e6;
    },
  });
  ```

  `llm.cost` is the sum for the invocation. A log-based metric on `jsonPayload.llm.cost` gives you spend over time, and an alert on it a spend alarm.
- **Streams.** Pass the stream itself, and iterate what comes back:

  ```ts
  for await (const chunk of logContext.llm(stream)) send(chunk);
  ```

  The chunks pass through untouched, errors reach you as before, and the entry gets the figures from across the chunks (providers send running totals, so the largest is kept), `ttftMs` (from the moment you pass the stream in, so do it as soon as the request returns), and `interrupted` when the stream failed or you stopped reading it early. An SDK stream object that offers a final message, such as Anthropic's `finalMessage()`, can be handed in once it is done instead.
- **Fallbacks.** `fallback(primary, secondary)` runs the attempts in turn and moves on only when the failure is `retryable`, which means the provider is at fault. A request that is itself wrong would be refused by the next provider too. Each attempt it leaves is recorded under `handledErrors` (`{ fallback: 0, error }`), and the last result is returned as is:

  ```ts
  const answer = fallback(
    () => ResultAsync.fromPromise(anthropic.messages.create(params), (e) => toExternalError("anthropic", e)),
    () => ResultAsync.fromPromise(openai.chat.completions.create(other), (e) => toExternalError("openai", e)),
  ).andTee((res) => logContext.llm(res));
  ```

  Combine it with `retry()` per attempt if you like: `fallback(() => retry(primary), secondary)`.
- **What isn't here.** Provider error catalogs: errors are classified by what they say about themselves (status, `Retry-After`, gRPC code, network error), and `classify` in `toExternalError` takes care of what is specific to one provider. A spend limit per user: it needs a store and a policy, so it is left to you. Prompts and responses are never recorded for you. Breadcrumbs (`logContext.debug`) appear only on failure and are a reasonable place for them, but patterns can't recognise free-form personal data.

## Security audit and investigation

resultlog writes the entries an investigation of unauthorized access needs, and labels them so that they are cheap to route and alert on. The `logging.googleapis.com/labels` field becomes the entry's `labels` in Cloud Logging.

- **Actor.** Each wrapped invocation records who made the request: `uid`, `signInProvider`, `authTime` (when the user signed in), App Check `appId` and `appCheck` (`verified`, `missing`, or `replayed` for a token that was used before), `ip`, `forwardedFor` (the raw `X-Forwarded-For`) and `userAgent`. The actor is written on audit and security entries. To have it on every entry, so that the digest can see an account used from many addresses in ordinary traffic, use `configure({ actor: "all" })`; see [Who made the call](#who-made-the-call). In `onRequest`, add a uid you verified yourself with `logContext.setActor({ uid })`.
- **Security events.** They use [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html) names and the label `security`. `unauthenticated` and `permission-denied` are logged as `securityEvent: "authz_fail"`, rejected input as `"input_validation_fail"`, and a replayed App Check token as `"authn_token_reuse"`. An error can declare its own with `securityEvent`, and `logContext.security()` records one where nothing fails. See [Detecting unauthorized access](#detecting-unauthorized-access).
- **Audit trail.** `logContext.audit(event, data?)` writes a NOTICE entry with the actor and the label `audit` straight away, so it survives a timeout. The invocation's final entry lists the same events under `auditEvents`, with the outcome. Use OWASP names where they fit: `authz_change`, `authz_admin`, `sensitive_read`, `sensitive_update`, `sensitive_delete`, `user_created`, `user_deleted`.
- **IP addresses** can be personal data when combined with other information (OWASP notes this too), so keep these entries in a bucket with restricted access. The left-most `X-Forwarded-For` entries come from the client and can be forged; the entries Google's front end appends on the right can be trusted.
- **Check auth inside the handler.** A call rejected by `onCall`'s `authPolicy` never reaches your handler, so nothing records the denial. To log it, check inside the handler and throw `HttpsError("permission-denied", …)`.

An audit entry:

```json
{
  "severity": "NOTICE",
  "message": "authz_change",
  "auditEvent": "authz_change",
  "target": "users/u9",
  "actor": {
    "uid": "u1",
    "signInProvider": "google.com",
    "authTime": "2026-10-22T09:12:00.000Z",
    "appId": "1:123:web:abc",
    "ip": "203.0.113.5",
    "userAgent": "Mozilla/5.0 …"
  },
  "logging.googleapis.com/labels": { "audit": "true" }
}
```

### Keep your audit trail with the Admin Activity audit logs

GCP already records administrative changes to your project, such as IAM policy changes, new service account keys and function deploys, as Admin Activity audit logs. They are always on, free, and kept for 400 days in the `_Required` bucket. To investigate an incident in one place, copy them into a bucket of their own, together with resultlog's audit and security entries:

```bash
PROJECT_ID=your-project
gcloud logging buckets create security-audit --location=global --retention-days=400
gcloud logging sinks create security-audit \
  "logging.googleapis.com/projects/$PROJECT_ID/locations/global/buckets/security-audit" \
  --log-filter='labels.audit="true" OR labels.security:* OR logName:"cloudaudit.googleapis.com%2Factivity"'
```

The copies count as ingestion, but Admin Activity volume is small. To make the bucket tamper-resistant, lock it. **Locking can't be undone**: afterwards nobody can delete the bucket or shorten its retention.

```bash
gcloud logging buckets update security-audit --location=global --locked
```

Nothing in your functions has to change to record these, and `resultlog monitoring` generates the alerts for the ones that matter most: Security Rules deployed, IAM policies changed, service account keys created, and Firebase or API key settings changed. See [Changes made to the project itself](#changes-made-to-the-project-itself). To count denials, which is a metric of resultlog's own entries: `gcloud logging metrics create authz-fail --log-filter='labels.security="authz_fail"'`, then add a Cloud Monitoring alert on the metric, for example more than 20 in 5 minutes.

Investigation queries for Logs Explorer:

- Everything a user did: `jsonPayload.actor.uid="UID" OR jsonPayload.authUid="UID"`
- Everything from an address: `jsonPayload.actor.ip="203.0.113.5"`
- Admin changes made by a principal: `protoPayload.authenticationInfo.principalEmail="someone@example.com"`

Data Access audit logs, which record every Firestore read and write, are off by default and can grow very large. resultlog's audit events cover sensitive operations far more cheaply.

## Detecting unauthorized access

resultlog records what your functions can see, in the shape security tools expect: events named after the [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html), each with the actor and a `security` or `audit` label. Alerting on them, and finding the actors behind them, is for Cloud Monitoring and `resultlog digest`. OWASP renamed this risk "Security Logging and Alerting Failures" in 2025: logging without alerting is of little value.

### What your functions can and cannot see

- **Firebase doesn't show your functions a failed sign-in.** Identity Platform's audit logs don't record the sign-in calls (`SignInWithPassword` and the like), and a blocking function runs only after the credentials were verified. Brute force and credential stuffing against sign-in belong to Firebase Authentication's own protections, MFA, reCAPTCHA Enterprise and, in front of your own endpoints, Cloud Armor.
- **What your functions do see:** calls that were refused or malformed, who made them, successful sign-ins (with `wrapBlocking`), and what an account does afterwards.

### What gets recorded

- `authz_fail`: `permission-denied` and `unauthenticated` automatically, and any error that declares it. A request for someone else's order can get a 404 and still be logged:

  ```ts
  class OrderNotFound extends defineError("OrderNotFound", { code: "not-found", securityEvent: "authz_fail" }) {}
  // the ownership check fails: the client sees NOT_FOUND, the log has authz_fail, the actor and the order id
  return err(new OrderNotFound(`orders/${id} belongs to someone else`, { context: { orderId: id } }));
  ```

- `input_validation_fail`: a zod schema rejected the input.
- `authn_token_reuse` (CRITICAL): an App Check token that was used before. Turn on replay protection on the sensitive callables with `consumeAppCheckToken: true` (a beta feature of the Node.js SDK that costs one more round trip per call). resultlog records the replay, and the actor's `appCheck` says `verified`, `missing` or `replayed`; refusing the request is your decision, or `enforceAppCheck`'s.
- `authn_login_success`, `user_created` and `authn_login_fail`: from `wrapBlocking`, below.
- Anything else you want a trail of: `logContext.security("sensitive_read", { collection })` for an event that is not a failure, `logContext.audit("authz_change", { target })` for an administrative change. Record an event one way or the other, not both.

### Who made the call

Audit and security entries carry the `actor`. `configure({ actor: "all" })` puts it on every entry, which is what the digest's per-account and per-address rules need to see ordinary traffic. Two things to weigh: it adds 100 to 250 bytes to each entry, and IP addresses and uids are personal data under many privacy laws, so keep the retention of those logs short and restrict who can read them. With `successSampleRate` below 1 the digest sees only a sample of ordinary traffic.

### Sign-ins: wrapBlocking

[`wrapBlocking`](#wrapblocking-function) puts Identity Platform's `beforeUserSignedIn` and `beforeUserCreated` on the record: every sign-in that gets through is the audit event `authn_login_success` (a sign-up is `user_created`), and a denial is the security event `authn_login_fail`.

- A policy that breaks (an exception, a timeout) denies the sign-in. A broken blocking function locks everyone out, so `failOpen: true` lets the sign-in through instead and logs the failure; a denial the policy returns on purpose is always honoured.
- It needs the project to be upgraded to Firebase Authentication with Identity Platform, and it runs after the credentials were verified, so a wrong password never gets here.

### Alerts

- **Count by event, not by actor.** A log-based metric can carry up to 10 labels and about 30,000 time series, and Google advises against extracting user ids or IP addresses into labels: every unique value costs money and can be throttled. Label by the event, and let the digest or a log query find the actor. `resultlog monitoring` generates the metrics and the alerts this way (see [Cloud Monitoring](#cloud-monitoring)): a metric of the security events labelled by event, an alert when they surge, and log-based alerts that notify on the entry itself for rare, serious events such as a replayed App Check token.
- **Per actor, per address: run the digest.** The rules below need counts per account and per address, which is what a metric must not carry. Run `resultlog digest` on a schedule you already have (a cron job, a CI schedule) and read the findings; do the same by hand during an investigation.

| Rule | What it looks for | Default | Severity |
|---|---|---|---|
| `authz-probing` | `authz_fail` by one actor | 10 within 5 min | medium |
| `validation-fuzzing` | `input_validation_fail` by one actor | 20 within 5 min | medium |
| `many-accounts-one-ip` | distinct accounts seen from one address (credential stuffing, spraying, an account farm, or an office behind one NAT) | 5 within 60 min | medium |
| `many-ips-one-account` | distinct addresses for one account (shared credentials, a takeover, or a user on the move) | 4 within 60 min | medium |
| `mass-access` | `sensitive_read` audit events by one account (scraping, exfiltration) | 100 within 10 min | high |
| `token-reuse` | `authn_token_reuse` | 1 | high |
| `privilege-change` | audit events for changes to permissions and accounts | 1 | info |
| `privilege-change-by-non-admin` | the same, by a uid not in `--admins` | 1 | high |

The rules are data, in the shape fail2ban and CrowdSec use: the entries that count (`filter`), counted per `key`, either as entries or as distinct values (`distinct`), and reported at `threshold` within `windowMs`. Add your own:

```ts
import { digest } from "resultlog/digest";

const { data } = digest(logs, {
  rules: [
    {
      name: "night-admin",
      severity: "medium",
      summary: "An administrative change was made at night.",
      hint: "Check with the admin that it was them.",
      filter: (p) => p.kind === "audit" && new Date(p.time ?? 0).getUTCHours() < 5,
      key: (p) => p.uid,
      threshold: 1,
    },
  ],
});
```

### When something is found

- **Stop the account.** Revoke its refresh tokens and, if needed, disable it, with the Admin SDK (`getAuth().revokeRefreshTokens(uid)`, `updateUser(uid, { disabled: true })`). An ID token that was already issued stays valid until it expires unless your code checks for revocation, so see Firebase's guidance on revoking sessions.
- **Block briefly, and at the edge.** Attackers rarely reuse addresses in a distributed attack, so block for 15 minutes or less rather than for long (Datadog's guidance), in Cloud Armor or whatever sits in front of your functions, not in the function.
- **Close what was used.** Fix the missing ownership check, turn on `enforceAppCheck` and replay protection, rotate any secret that could have been read.
- **Keep the evidence:** the digest and the entries, in a bucket that cannot be altered (see [Keep your audit trail with the Admin Activity audit logs](#keep-your-audit-trail-with-the-admin-activity-audit-logs)).

### What resultlog does not do

- **No scanning of payloads for attack strings.** That is a list of patterns with many false positives; Cloud Armor and Arcjet do it better.
- **No rate limiting or lockout.** They need shared state, and an attacker can turn a counter in Firestore into cost. Put them at the edge: App Check, reCAPTCHA Enterprise, Cloud Armor, or a service built for it such as Arcjet or Upstash.
- **No geolocation, IP reputation or device fingerprints.** They need data resultlog doesn't have.
- **Not verified against a live project:** the mapping of the labels, the alerts, and Identity Platform in production (the blocking function was exercised in the Auth emulator only).

## Cloud Monitoring

resultlog's entries are meant to be read and alerted on in Cloud Logging and Cloud Monitoring. You can set that up by hand in the console with the recipes below, or have `resultlog monitoring` write the setup as files.

### By hand, in the console

**An alert on one kind of entry.** In Logs Explorer, run one of the queries below (the line under each heading), open **Actions → Create log alert**, and fill in a name, a severity, the time between notifications and where to notify. A log alert notifies about the entry itself, so use it for events that are rare and serious. It can't count: for "more than 5 in 5 minutes", make a log-based metric from the same filter (the command below writes nine) and alert on the metric. A log alert doesn't see logs that an exclusion filter drops.

```text
# A server-side failure (ERROR or worse)
resource.type="cloud_run_revision" AND severity>=ERROR AND jsonPayload.errorName:*

# Any 5xx answer, including the platform's own
resource.type="cloud_run_revision" AND httpRequest.status>=500

# A replayed App Check token
resource.type="cloud_run_revision" AND jsonPayload.securityEvent="authn_token_reuse"

# A permission or account change
resource.type="cloud_run_revision" AND jsonPayload.auditEvent=~"^(authz_(change|admin)|privilege_|user_(created|updated|archived|deleted))"

# A function cut off by its timeout
resource.type="cloud_run_revision" AND jsonPayload.errorName="DeadlineExceeded"

# An LLM answer cut off, withheld or interrupted
resource.type="cloud_run_revision" AND (jsonPayload.llm.truncated>0 OR jsonPayload.llm.blocked>0 OR jsonPayload.llm.interrupted>0)

# Firebase Security Rules were created, deployed or deleted
logName:"cloudaudit.googleapis.com%2Factivity" AND protoPayload.serviceName="firebaserules.googleapis.com" AND protoPayload.methodName:("CreateRuleset" OR "CreateRelease" OR "UpdateRelease" OR "DeleteRelease" OR "DeleteRuleset")

# An IAM policy was set: members added, roles changed
logName:"cloudaudit.googleapis.com%2Factivity" AND protoPayload.methodName:"SetIamPolicy"

# A service account key was created or uploaded
logName:"cloudaudit.googleapis.com%2Factivity" AND protoPayload.serviceName="iam.googleapis.com" AND protoPayload.methodName=("google.iam.admin.v1.CreateServiceAccountKey" OR "google.iam.admin.v1.UploadServiceAccountKey")

# Firebase project settings or an API key were changed
logName:"cloudaudit.googleapis.com%2Factivity" AND protoPayload.serviceName=("firebase.googleapis.com" OR "apikeys.googleapis.com")
```

The last four are not about your functions: they are entries Google writes about the project itself, so they have no `resource.type="cloud_run_revision"`. See [Changes made to the project itself](#changes-made-to-the-project-itself).

To be told when one particular failure comes back, add `AND jsonPayload.fingerprint="…"` to the first filter; the digest and the entry give the fingerprint. Narrow any of the first six to one function with `AND resource.labels.service_name="getuser"`.

**Rows that say more.** Logs Explorer shows each entry as a line with chips. In **Preferences → Manage summary fields**, add `jsonPayload.errorName`, `jsonPayload.durationMs`, `jsonPayload.authUid` and `jsonPayload.securityEvent`, then **Apply**. Each row then shows the kind of failure, how long it took, who called and the security event next to the message. It is a display setting: it changes nothing that is logged.

### Or have the files written for you

`resultlog monitoring` writes log-based metrics, alert policies and a dashboard, as the JSON that `gcloud` takes. It only writes files and never talks to Google Cloud: you read them, then apply them with the commands in the `README.md` it writes next to them.

```bash
npx resultlog monitoring --project my-project \
  --notification-channel projects/my-project/notificationChannels/1234567890
```

Find a channel's name with `gcloud beta monitoring channels list --format='value(name,displayName)'`. Without `--notification-channel` the alerts are created without one, and you add it in the console.

### What you get

- **9 log-based metrics**, all counters: failures (by error name, error code and severity), security events and audit events (by kind), timeouts, cold starts, duplicate events, and LLM answers cut off, withheld and interrupted. Their labels hold few values on purpose: a label with a user id or an address would cost a time series for each.
- **10 alert policies**, each with documentation that says what it means and what to do. The first six come with the digest command that looks closer:
  - **server errors**: more than 5 in 5 minutes for one function (ERROR or worse; expected failures such as not-found don't count);
  - **security events surge**: more than 20 of one kind in 5 minutes;
  - **App Check token replayed** and **permissions or accounts changed**: log-based alerts, which notify on the entry itself (at most once in 5 minutes), because these are rare and a count over a window would hide them;
  - **functions timing out**: more than 3 in 10 minutes;
  - **LLM answers cut off, withheld or interrupted**: more than 5 of any kind in 10 minutes;
  - four **log-based alerts about the project itself**: Firebase Security Rules changed, IAM policy changed, service account key created, Firebase project or API key changed. See [Changes made to the project itself](#changes-made-to-the-project-itself).
- **A dashboard**, "resultlog: functions": Cloud Run's own request count and latency (p50, p95), then resultlog's metrics (failures, security events, audit events, timeouts, duplicates and cold starts, LLM problems), and two panels that list the entries: security and audit entries, and failures.

Options: `--service checkout,on-order` covers only those functions (by Cloud Run service name, which is the function name in lower case), `--threshold errors=10` changes an alert's threshold (`errors`, `security-events`, `timeouts`, `llm-problems`), `--prefix` changes the names, and `--out` the directory (default `./monitoring`). The generated `README.md` in it explains each file.

### Changes made to the project itself

Google Cloud writes an Admin Activity audit log entry whenever someone changes the project: deploys Security Rules, sets an IAM policy, creates a service account key, adds a Firebase app or edits an API key. These entries are **always written, and can't be configured, excluded or switched off**, and they cost nothing, so recording them needs nothing from you and nothing in your functions. What does not happen by itself is a notification: Cloud Logging tells nobody until an alert exists. `resultlog monitoring` writes four log-based alerts for them (the same filters as in the console recipes above, so that you can also create them by hand):

| Alert | Fires on | Why it matters |
|---|---|---|
| Firebase Security Rules changed | `CreateRuleset`, `CreateRelease`, `UpdateRelease`, `DeleteRelease`, `DeleteRuleset` of `firebaserules.googleapis.com` | the rules are what stands between your data and everyone else; open rules are how data leaks |
| IAM policy changed | any `SetIamPolicy`: the project, a service account (`google.iam.admin.v1.SetIAMPolicy`), a function made public, and other resources | who can do what, or impersonate whom |
| Service account key created | `CreateServiceAccountKey` and `UploadServiceAccountKey` of `iam.googleapis.com` | a key is a password in a file that does not expire |
| Firebase project or API key changed | everything written by `firebase.googleapis.com` (apps, SHA certificates, the project) and `apikeys.googleapis.com` (API keys are the API Keys API's, not Firebase's) | a new app or a key without its restrictions widens who can call your backend |

- Each notifies at most once in 5 minutes and names, in its documentation, the `gcloud logging read` command that shows who did it and from where (`protoPayload.authenticationInfo.principalEmail`, `protoPayload.requestMetadata.callerIp`).
- **They also fire on your own work.** A deploy of your rules is a rules change. That is the point of an alert like this: you check that it was you. If a team deploys rules many times a day and wants the alert only for other people, narrow the filter by the principal (`AND NOT protoPayload.authenticationInfo.principalEmail:"ci@"` and so on).
- `:` ignores case and matches a part of the value. That is why `SetIamPolicy` also catches the service account variant `google.iam.admin.v1.SetIAMPolicy`; an exact `="SetIamPolicy"` would see only the project's.
- They see **changes**, not reads. Reading a key's value or a project's configuration is a Data Access audit log, which is off by default and can grow large.
- `--service` and `--prefix` apply to the function alerts; these four look at the whole project. Apply only the ones you want: each alert is its own file under `alerts/`.

### Applying it

The generated `README.md` has the commands with your project id. In short, from the output directory, once:

```bash
for f in metrics/*.json; do gcloud logging metrics create "$(basename "$f" .json)" --config-from-file "$f"; done
for f in alerts/*.json; do gcloud monitoring policies create --policy-from-file "$f"; done
gcloud monitoring dashboards create --config-from-file dashboard.json
```

`policies create` and `dashboards create` add a second copy if you run them again, so to change something later (a threshold, say: generate again with `--threshold errors=10`), replace it instead. `gcloud logging metrics update NAME --config-from-file FILE` updates a metric. `gcloud monitoring policies update POLICY --policy-from-file FILE` replaces a policy in place, so its incident history stays, but it replaces all of it, including edits you made in the console; find POLICY with `gcloud monitoring policies list`. A dashboard can't be updated from a file without its current etag, so delete it and create it again. Add `--validate-only` to `dashboards create` to have Google check the file without saving it.

From code, `import { monitoring, files } from "resultlog/monitoring"`: `monitoring(options)` returns the metrics, alerts and dashboard as plain objects, so a Terraform, Pulumi or CDK setup can build its resources from them, and `files(options)` returns the file set the command writes.

### Things to know

- **The metrics count log entries.** Failures, security events and audit events are always logged, so their counts are complete. Ordinary successes can be sampled away (`successSampleRate`), which is why the request charts use Cloud Run's own metrics.
- **Per user or per address is not in the metrics.** Run the digest for that.
- **Cost.** User-defined log-based metrics are billed under Cloud Monitoring's pricing, and every distinct label value is a time series. The generated labels are event names, error names and severities. Add no label that holds an id.
- **Second-generation functions only:** the filters select `resource.type="cloud_run_revision"`.
- **Check the first run.** The files follow Google's API reference, and the filters are tested against the entries the library really writes and the Admin Activity entries Google documents. Start with `dashboards create --validate-only` and read the output of the first run: if Google's API asks for a field to be adjusted, the files are plain JSON.

## Investigating with an AI assistant

Each entry is one self-describing record of an invocation: stable field names, secrets already redacted, and a `fingerprint` that names the kind of failure. That makes the logs easy for an AI assistant to read, and `resultlog digest` makes them small enough to hand over:

```bash
gcloud logging read 'resource.type="cloud_run_revision"' --freshness=1d --limit=3000 --format=json \
  | npx resultlog digest --pseudonymize > digest.md
```

Then give `digest.md` to the assistant: "Here is yesterday's digest of our functions. Which failure group should we fix first, what is the likely cause, and what would you check next?"

The digest reads what `gcloud logging read` returns (a JSON array, or one JSON value per line, as a log export gives) and reports:

- **findings**: what the detection rules found, most serious first, each with the evidence and what to do next (see [Detecting unauthorized access](#detecting-unauthorized-access));
- the time window, the number of entries and their severities, and the invocations, counting each sampled success at its weight, so that rates stay right;
- per function: invocations, failure rate, p50 and p95 duration, cold starts;
- **failure groups**, by `fingerprint`: how many, which functions, when, whether it can be retried, the message, the upstream calls that failed, the breadcrumbs, a trace id and a trimmed sample entry;
- **security**: events by kind, the actors behind them (uid, address, user agent), the busiest minute, and the audit events;
- outgoing hosts ranked by failure rate and latency, LLM tokens and cost per model (with the cut-off, withheld and interrupted calls), and timeouts, duplicates, handled errors and the reasons retries stopped.

Options: `--format json` for the same data, `--top N` for how many items each list keeps, `--max-chars N` (default 20,000) for a hard cap on the Markdown. Under the cap, each section gets its first item before any gets a second, so no section crowds out the others, and what is dropped is counted. Include INFO entries in the export if you want failure rates and latency percentiles: with `severity>=WARNING` the digest only sees the failures.

Detection options: `--admins uid1,uid2` (uids that may change permissions and accounts: a change by anyone else becomes a high finding) and `--threshold rule=N` (repeatable) to change a rule's threshold. From code, `digest(logs, { admins, thresholds, rules })` also takes rules of your own.

**Privacy.** A digest holds uids, IP addresses and user agents, and whatever your messages say. Before you paste it into a service you don't control, add `--pseudonymize`: those three become stable pseudonyms (`user_7b4ae8`), so patterns stay visible, and they differ on every run. Free text (messages, attributes you set) is not touched. That is one more reason to keep personal data out of attributes.

From code: `import { digest, parseLogs } from "resultlog/digest"`; `parseLogs(text)` returns `{ logs, skipped }` and `digest(logs, { top, maxChars, pseudonymize })` returns `{ data, markdown }`.

**Fingerprint.** `fingerprint` is 12 hex characters for the kind of failure. It is built from the error's name and code, where it was raised (the function and file, not the line, so a deploy doesn't change it) and, for an upstream failure, the provider and the class of the status (500 and 503 are both `5xx`). The message is left out, because it holds ids. Query it in Logs Explorer: `jsonPayload.fingerprint="b49c01a8ca7b"`.

**For AI coding assistants,** `llms.txt` ships in the package: the API in brief, the rules for using it, and a dictionary of the log fields. Add `node_modules/resultlog/llms.txt` to the assistant's context (in Claude Code, `@node_modules/resultlog/llms.txt`).

## Log cost

Cloud Logging charges $0.50 per GiB ingested after the first 50 GiB per project each month. That includes 30 days of retention; keeping logs longer costs $0.01 per GiB per month.

- **One entry per invocation** instead of a line per step, and DEBUG breadcrumbs only on failure, are the main savings.
- **Sampling.** Keep only a share of fast, successful runs:

  ```ts
  configure({ successSampleRate: 0.1, slowMs: 1000 }); // keep 10% of successes faster than 1 s
  ```

  Failures, runs slower than `slowMs`, audited runs, runs with handled errors, duplicates, cold starts and runs with a cut-off, withheld or interrupted LLM call are always logged. Sampled entries carry `sampleRate`, so multiply counts by `1 / sampleRate` when you aggregate.
- **Size caps.** Strings longer than 2,000 characters and arrays longer than 100 items are cut, and values nested deeper than 5 levels become `"[Truncated]"`. An entry larger than 100 KB is replaced by its key fields (error name and code, actor, duration, …) plus `truncatedBytes`, because Cloud Logging rejects entries over 256 KB.
- **The actor on every entry** (`configure({ actor: "all" })`) adds 100 to 250 bytes to each entry. Sampling successes away (`successSampleRate`) then also thins what the digest can see of ordinary traffic.
- **`httpRequest` and `context`.** The `httpRequest` of a callable or HTTP function adds about 90 bytes to each of its entries, and the `context` of an ERROR about 90 more; for 3 million invocations a month that is about 0.25 GiB. Where the actor is shown, the address and user agent are written in `httpRequest` as well as in `actor` (and in the `context` of an ERROR), which adds up to a few hundred bytes more when the user agent is long. They are standard fields that Logs Explorer and Error Reporting read themselves; there is no switch to turn them off.
- **Estimate.** Entries per month × average size. For example, 3 million invocations at about 1 KB each is roughly 3 GiB a month, well within the free 50 GiB.
- **Platform request logs.** Cloud Run also writes a request log for every HTTP call (`run.googleapis.com/requests`), which largely duplicates the wide event. An exclusion filter such as `logName:"run.googleapis.com%2Frequests" AND httpRequest.status<400` drops the successful ones. The pricing page charges for logs streamed into log buckets, so excluded entries shouldn't be billed; confirm this on your own bill. The wide event of a callable or HTTP function carries `httpRequest` with the same status and latency, so a query on `httpRequest.status>=500` still finds what your functions answered; the request log you keep (status 400 and up) also has the cases where the platform answered instead of your code. That request log is the only record of the client IP for ordinary (non-audit) requests.

## Redaction

Two things are redacted, at any depth: attributes, error context, breadcrumb data, causes and the log message itself (an SDK's error message often quotes the key it rejected).

- **By key.** A value whose key matches `/password|secret|token|authorization|cookie|api[-_]?key/i` becomes `"[REDACTED]"`. Token *counts* are not secrets, so a number under a key such as `max_tokens`, `inputTokens` or `promptTokenCount`, and the `…_tokens_details` object, are left alone. `token`, `accessToken` and a list called `tokens` are redacted.
- **By pattern.** Wherever they appear in a string:
  - JWTs (`[REDACTED:jwt]`), and `Bearer` tokens of 16 characters or more,
  - API keys: Stripe (`sk_live_`, `rk_`, `whsec_`), OpenAI and Anthropic (`sk-…`), Google (`AIza…`), AWS access key ids (`AKIA…`), GitHub and Slack tokens (all `[REDACTED:key]`),
  - private key blocks (`[REDACTED:private-key]`),
  - secrets in URL query strings (`api_key=…`, `token=…`, `key=…`, `signature=…`, `password=…`),
  - card numbers (Visa, Mastercard, Amex, Discover, JCB) that pass the Luhn check (`[REDACTED:card]`). The check and the card prefixes keep timestamps and ids from being mistaken for cards.
- **Your own.** `configure({ secretPatterns: [/internal-\d{6}/] })` adds patterns, replaced by `[REDACTED:custom]`.

Patterns catch what a key name can't, such as a key inside a prompt, a URL or an error message. They are not a data-loss-prevention tool: names, e-mail addresses and free-form personal data are not detected, so keep them out of logs, and out of `logContext.set` in particular. A long numeric id that happens to pass the card checks can be masked by mistake.

Circular references become `"[Circular]"` and `bigint` values become strings. Objects with a `toJSON` method (dates, axios errors, Firestore timestamps) are written through it, and other class instances as their own fields.

## Limitations

- Only work inside a wrapped handler is captured. What Google Cloud records about the project itself (Security Rules, IAM, keys) is in the Admin Activity audit log, which [`resultlog monitoring`](#changes-made-to-the-project-itself) watches.
- When `wrapEvent` rethrows, the Functions runtime may log the error again, so Error Reporting can count it twice.
- The timeout guard answers for a slow invocation but can't stop its code. Pass `logContext.signal` to the calls that can be cancelled.
- A stack trace survives only if what you return or throw is an `Error`. Return `AppError` subclasses, not strings.
- The fields resultlog writes (`actor`, `auditEvent`, `auditEvents`, `securityEvent`, `securityEvents`, `httpRequest`, `context`, `errorName`, `errorCode`, `fingerprint`, `publicMessage`, `retryable`, `durationMs`, `breadcrumbs`, `cause`, `sampleRate`, `handledErrors`, `retries`, `external`, `llm`, `coldStart`, `duplicate`, `provider`, `upstream`) replace attributes with the same name.

## Development

```bash
npm ci                 # the lockfile is npm's; Bun only runs the tests
bun test
npm run typecheck
npm run build          # dist/esm and dist/cjs
npm run smoke          # the build, on the Node that runs it
npm pack --dry-run     # what a publish would contain
```

The source is one module per concern under `src/`; `AGENTS.md` describes the layout, the conventions and how a release is made. CI installs through [Takumi Guard](https://shisho.dev/docs/ja/t/guard/quickstart/npm/), and a release is staged on npm by a workflow and approved by a maintainer with 2FA.

## License

[MIT](LICENSE)
