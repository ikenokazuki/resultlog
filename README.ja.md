# resultlog

[English](README.md)

Firebase Functions (v2) のハンドラから [neverthrow](https://github.com/supermacro/neverthrow) の `Result` を返すだけで、実行ごとに次のものが得られます。

- **1 本の構造化ログ**（wide event）。処理の途中で付け足した情報がすべて入ります。
- **スタックトレースと原因（cause）を保ったエラー**。Cloud Error Reporting に送るのはサーバー側の障害だけです。
- **失敗したときだけ書き出される DEBUG パンくず**。
- **zod による入力検証**。`request.data` / `req.body` の型はスキーマから決まります。
- **監査証跡とセキュリティイベント**。不正アクセスの調査に使え、GCP の管理アクティビティ監査ログと一緒に保管できます。
- **外部 API のエラーを 1 つのモデルに統一**。Stripe、OpenAI / Anthropic / Gemini、Firestore などの gRPC クライアント、fetch、axios に対応します。
- **Cloud Logging の費用を抑える仕組み**。成功ログのサンプリングと、1 エントリあたりのサイズ上限です。
- **重ねがけにならないリトライ**。SDK やライブラリ自身のリトライと重なりません。未知の SDK でも検知します。
- **タイムアウトのガード**。遅い実行がプラットフォームに強制終了される前にログを書いて応答し、処理中の呼び出しを止められる `AbortSignal` を渡します。
- **イベントの重複処理の防止**。イベントトリガーの「少なくとも 1 回」配信に対応します。
- **パターンによる秘密情報のマスキング**。キー名だけでなく、API キー・JWT・カード番号も値から検出します。
- **外部への HTTP 呼び出しの要約**（ホストごとの回数・ステータス・時間）と、`coldStart` の記録。
- **LLM 呼び出しの記録**。トークン数、モデル、終了理由、最初のチャンクまでの時間を、どの SDK のレスポンスからでも読み取ります（提供元の一覧は持ちません）。費用は自分で用意した価格の関数から計算します。
- **AI と一緒に作業するための道具**。失敗の種類を表す `fingerprint`、1 日分のログを AI アシスタントに渡せる大きさのレポートにする `resultlog digest`、ハンドラが何をログに出したかをテストで検証できるテスト用ヘルパー、AI コーディングアシスタント向けの `llms.txt` です。
- **小さなクライアント用ヘルパー**。失敗した呼び出しを、フォームの項目ごとのメッセージに変換します。
- **不正アクセスの検知**。OWASP Logging Vocabulary の名前を使ったセキュリティイベント（エラーに宣言するか、`logContext.security` で記録）、App Check の状態とリプレイの検知、Identity Platform のブロッキング関数によるサインインのイベント、全エントリに載せられる `actor`（任意）、digest の検知ルール。
- **Cloud Monitoring の設定**。resultlog が書き出すものに合わせたログベース指標、アラートポリシー、ダッシュボードを生成し、適用するスクリプトも付きます（`resultlog monitoring`）。

## 解決する課題

Firebase Functions と Result 型を組み合わせるプロジェクトでは、次のものを毎回作り直すことになりがちです。

1. **スタックトレースが消える。** `err("not found")` や `err({ type: "NOT_FOUND" })` はスタックを持たないため、ログや Error Reporting から発生箇所を追えません。
2. **エラーの振り分け。** どのエラーを警告にし、どれで通知を飛ばし、どれをリトライし、クライアントに何を見せてよいかを、ハンドラごとに決め直すことになります。
3. **ログが多すぎるのに、肝心な情報がない。** 成功したリクエストでも INFO ログが大量に出て課金がかさむ一方、失敗したときに見たい DEBUG ログは出ていません。
4. **調査に必要な記録がない。** 不正アクセスが疑われたとき、誰が・どこから・何をして・成功したのかを知る必要がありますが、普段のログには一貫した形で残っていません。
5. **API ごとにエラーの形が違う。** Stripe、生成 AI、gRPC、fetch はそれぞれ別の形で失敗を返すため、リトライや通知のルールがあちこちに散らばります。

## 導入

resultlog はまだ npm に公開していません。公開するまでは、このリポジトリで tarball を作り、Functions のプロジェクトにインストールしてください。

```bash
bun install
npm pack                              # dist/ をビルドして resultlog-0.1.0.tgz を作ります
npm install ./resultlog-0.1.0.tgz     # Functions のプロジェクトで実行
```

ESM と CommonJS の両方と型定義を同梱していて、`module: nodenext`（Firebase の既定）、`bundler`、従来の `node` 解決のいずれでも使えます。

必要なもの（一般的な Functions プロジェクトなら大半は導入済みです）:

- Node.js 20 以上
- `firebase-functions` 6 または 7（v2 API）と `firebase-admin`
- `neverthrow` 8
- `zod` 4: 省略可。渡すスキーマの型にだけ必要です
- TypeScript 5.4 以上

テストは firebase-functions 7.4、6.6、6.0 で通り、peer 範囲が許す最低版（firebase-admin 11.10、firebase-functions 6.0、neverthrow 8.0、zod 4.0）でも通ります。型定義は、`skipLibCheck` が有効でなければ firebase-functions 7 が必要です（6 は `firebase-functions/v2/https` から `Response` と `CallableResponse` を export していないため）。

エントリポイント: `resultlog`（サーバー側）、`resultlog/client`（アプリ用。サーバー側のモジュールを import しません）、`resultlog/testing`、`resultlog/digest`、`resultlog/monitoring`、そして `resultlog` コマンド（`digest` と `monitoring`）です。

## クイックスタート

```ts
import { getFirestore } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { err, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import { defineError, logContext, wrapCall } from "resultlog";

class UserNotFound extends defineError("UserNotFound", { code: "not-found", publicMessage: "ユーザーが見つかりません。" }) {}
class DbError extends defineError("DbError", { code: "internal" }) {} // severity は ERROR。クライアントには "INTERNAL" だけが返る

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

## ハンドラアダプタ

ハンドラを包んでから、いつもどおりトリガーに渡します。ハンドラは `Result`、`ResultAsync`、`Promise<Result>` のいずれを返しても構いません。

| アダプタ | 使う場所 | 初期属性 | Ok | Err（WARNING） | Err（ERROR / CRITICAL） |
|---|---|---|---|---|---|
| `wrapCall([schema,] fn, options?)` | `onCall` | `authUid`, `httpRequest` | 値をクライアントに返す | `HttpsError(code, publicMessage, details)` を throw | `HttpsError(code, publicMessage)` を throw（details なし） |
| `wrapRequest([schema,] fn, options?)` | `onRequest` | `httpRequest`（method, path） | `200` で値を JSON 返却 | コードに対応する HTTP ステータスで `{ error: { status, message, details } }` を返す | 同じ形で `details` なし |
| `wrapEvent(fn, options?)` | Pub/Sub、Firestore、Scheduler など | `eventId`, `eventType` | — | ログを出して正常終了（`retryable` なエラーは再 throw） | ログを出して再 throw（リトライ有効ならリトライされる。`retryable: false` なら正常終了） |
| `wrapBlocking(fn, options?)` | `beforeUserSignedIn`、`beforeUserCreated` | `eventId`, `eventType` | Firebase に返す（カスタムクレームなど）。監査イベント `authn_login_success`（サインアップは `user_created`）を記録 | `HttpsError` を throw。セキュリティイベント `authn_login_fail` を記録 | 同じ。ただし `failOpen: true` ならサインインを通す |

- **スキーマ。** zod スキーマを渡すと、`fn` の実行前に `request.data`（または `req.body`）を `safeParseAsync` で検証し、型もスキーマから付きます。不正な入力は `InvalidInput` エラー（`invalid-argument`、WARNING）になり、`fn` は呼ばれません。zod の `issues` はログに残り、クライアントにも `details.issues` として返るので、フォームで項目ごとのエラーを表示できます。スキーマなしの場合、`request.data` は `unknown` です。
- **省略可能な項目。** Firebase のクライアント SDK は `undefined` のプロパティを `null` として送ります。省略可能な項目は `.optional()` ではなく `.nullish()` で宣言してください。
- **ストリーミング。** `wrapCall` は `onCall` のストリーミング用 `response` をハンドラの第 2 引数に渡します: `(request, response) => { response?.sendChunk(part); … }`
- **throw された例外**は、元のスタックを保ったまま `internal` の ERROR として記録します。`HttpsError` が throw された場合はそのコードと details を維持するので、既存のハンドラを包んでもクライアントへの応答は変わりません。
- **`wrapRequest`** は、ハンドラが自分で応答済み（`res.headersSent`）なら何も送りません。
- **`wrapEvent`** は、ジェネリックなトリガー関数を通すとイベントの型を推論できません。型注釈を付けるか、トリガーに型引数を渡してください。

  ```ts
  onMessagePublished("orders", wrapEvent((event: CloudEvent<MessagePublishedData>) => handle(event)));
  onMessagePublished<Order>("orders", wrapEvent((event) => handle(event.data.message.json)));
  ```

  イベントのペイロードは自動では検証しません。ハンドラ内で zod を使って検証してください。

- **`maxEventAgeMs`。** `wrapEvent(fn, { maxEventAgeMs: 60 * 60 * 1000 })` とすると、CloudEvent の `time` が上限より古いイベントは `fn` を実行せずに正常終了し、`EventTooOld` の WARNING として記録します。リトライを有効にすると、Cloud Functions（第 2 世代）は失敗したイベントを最大 24 時間リトライし続けます。これを早めに打ち切ります。

## タイムアウト

時間切れになった関数はプラットフォームに強制終了され、最終的なログは出ず、クライアントには解釈できないエラーが返ります。最も調べたい実行がまさにこれです。resultlog にタイムアウトの値を伝えると、少し早めに介入します。

```ts
setGlobalOptions({ timeoutSeconds: 60 }); // プラットフォームの設定
configure({ timeoutSeconds: 60 });         // resultlog 用に同じ値を指定（プラットフォームは値を公開していません）
```

- `timeoutSeconds - timeoutMarginMs`（マージンの既定は 1,000 ms）が経過すると、その実行を打ち切ります。ログを書き（`DeadlineExceeded`、ERROR。それまでに集めた `external` やパンくずもすべて入ります）、クライアントには `deadline-exceeded` を返し、`onRequest` の呼び出し元には `504` を返し、イベントは再 throw してプラットフォームにリトライさせます。
- ハンドラ自体を止めることはできません。`logContext.signal` はその瞬間に abort される `AbortSignal` なので、止められる呼び出しに渡してください: `fetch(url, { signal: logContext.signal })`、または SDK の `signal` オプション。長い LLM の呼び出しやエージェントのループを止めるのにも使えます。
- `retry()` は期限を認識します。期限を過ぎてまで待つことはなく、期限を過ぎたら次の試行を始めません。
- 関数ごとに別のタイムアウトを指定する場合: `wrapCall(fn, { timeoutSeconds: 300 })`、`wrapRequest(fn, { timeoutSeconds: 300 })`、`wrapEvent(fn, { timeoutSeconds: 300 })`。`timeoutSeconds` がなければガードは働きません。
- 打ち切られた関数について、そのログが「何をしていたか」の唯一の記録になります。バックグラウンドで続く処理は記録されません。

## ハンドラ内でのログ

- `logContext.set(attrs)` は、その実行の 1 本のログに項目を追加します。`andTee` と組み合わせると便利です: `.andTee((user) => logContext.set({ plan: user.plan }))`
- `logContext.debug(message, data?)` はパンくずをメモリに保持します（最新 50 件）。パンくずは、実行が失敗したときだけ `breadcrumbs` として書き出されます。
- `logContext.error(error, data?)` は、回復済みのエラー（キャッシュの失敗から別経路に切り替えた場合など）を `handledErrors` に記録します。実行自体は成功のままです。`orElse` と組み合わせて使います: `.orElse((e) => { logContext.error(e, { step: "cache" }); return readFromDb(); })`
- `logContext.audit(event, data?)` は監査ログを即座に書き出します（[セキュリティ監査](#セキュリティ監査と調査)を参照）。ラップしたハンドラの外でも動きます。
- `logContext.security(event, data?, { severity? })` は、セキュリティイベントを actor と `security` ラベル付きですぐに書き出します（[不正アクセスの検知](#不正アクセスの検知)を参照）。何も失敗していないが記録を残したい場所で使います。たとえば `sensitive_read` です。
- `logContext.setActor(fields)` は、リクエストした人の情報を追加します。たとえば `onRequest` で自分で検証した uid を記録するときに使います。

`set`、`debug`、`error`、`setActor` は、ラップしたハンドラの外では何もしません。コンテキストは `AsyncLocalStorage` に保持されるため、同時に走る実行同士で混ざることはありません。

## テスト

`resultlog/testing` に、ハンドラのテストに必要なものがあります。ログのエントリは自分で制御できる出力先（sink）に送られるので、テストでハンドラが何をログに出したかを検証できます。

```ts
import { afterEach, expect, test } from "bun:test";
import { callableRequest, captureLogs } from "resultlog/testing";

const logs = captureLogs();
afterEach(() => logs.clear());

test("存在しないユーザーは警告になり、クライアントには理由が伝わる", async () => {
  await expect(getUser(callableRequest({ id: "u9" }, { uid: "u1" }))).rejects.toMatchObject({
    code: "not-found",
    details: { reason: "UserNotFound" },
  });
  expect(logs.entries).toMatchObject([{ severity: "WARNING", errorName: "UserNotFound", authUid: "u1" }]);
});
```

- `captureLogs()` がエントリを集めます。`clear()` でテストごとに空にでき、`restore()` で元の sink に戻します。
- `callableRequest(data, { uid, token, ip })`、`httpExchange({ method, path, body, headers })`（`{ req, res, sent }` を返し、`sent` にハンドラが返したステータスと本文が記録されます）、`cloudEvent(data, { id, type, time })` が、`wrapCall`・`wrapRequest`・`wrapEvent` への入力を作ります。
- 包んだハンドラ自体（`const getUser = wrapCall(...)`）を呼ぶか、Firebase 自身のラッパーを通したいなら `onCall(getUser).run(request)` を使います。
- 裏にあるオプションは `configure({ sink })` です。sink は、プラットフォームのロガーの代わりにすべてのエントリを受け取ります。エントリを別の場所へ送ったり、ローカル開発で画面に出したりするのにも使えます。sink が例外を投げても無視されます。ログがログ対象のコードを壊してはならないからです。

## 出力されるログ

成功時:

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

想定内の失敗（WARNING）:

```json
{
  "severity": "WARNING",
  "message": "users/u9 does not exist",
  "authUid": "u1",
  "httpRequest": { "requestMethod": "POST", "requestUrl": "/", "status": 404, "latency": "0.012s" },
  "errorName": "UserNotFound",
  "errorCode": "not-found",
  "fingerprint": "b49c01a8ca7b",
  "publicMessage": "ユーザーが見つかりません。",
  "retryable": false,
  "durationMs": 12,
  "breadcrumbs": [{ "timestamp": "2026-10-22T10:00:00.010Z", "level": "DEBUG", "message": "looking up user", "data": { "id": "u9" } }]
}
```

サーバー側の障害（ERROR）。Error Reporting に拾われます:

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

### Cloud Logging で読みやすくするための項目

- **メッセージは 1 行で読めます。** 成功は `getuser ok 42 ms` のようになります。関数名（Cloud Run のサービス名で、`K_SERVICE` から取ります。ない環境では省きます）、結果、所要時間です。WARNING のメッセージはエラー自身のメッセージ、ERROR のメッセージはスタックトレースで始まります。Error Reporting がそこから読むためです。
- **`httpRequest`。** callable と HTTP 関数のエントリには、Cloud Logging の `httpRequest` フィールドが付きます。`requestMethod`、`requestUrl`（パスだけ。クエリ文字列に秘密情報が入りうるためです）、`status`（クライアントが受け取ったもの。200、またはエラーコードに対応する HTTP ステータス）、`latency` です。Logs Explorer はこのフィールドを知っているので、`httpRequest.status>=500` のように絞り込めます。`remoteIp` と `userAgent` は actor がある場所にだけ入ります（監査・セキュリティのエントリ、または `configure({ actor: "all" })` なら全エントリ）。さらに `remoteIp` は、有効なアドレスのときだけ入ります。偽造された `X-Forwarded-For` で `req.ip` は何にでもなりうるからです。actor には元の値が残ります。イベントとブロッキング関数にはリクエストへの応答がないので、`httpRequest` は付きません。
- **Error Reporting の `context`。** ERROR と CRITICAL のエントリには `context.user`（Firebase の uid）と `context.httpRequest`（`method`、`url`、`responseStatusCode`。`remoteIp` と `userAgent` は同じ規則）も付きます。Error Reporting が、エラーに紐づくユーザーとリクエストとして文書化しているフィールドです。イベントにはどちらもないので `context` は付きません。

`httpRequest` を持つエントリを Logs Explorer がどう要約するか、`context` から Error Reporting が何を表示するかは、実プロジェクトでは確認していません。

## エラー

`defineError(name, { code, publicMessage?, severity?, retryable? })` は `AppError` のサブクラスを返します。名前付きのクラスで継承すると、エディタのホバーや型エラーに無名クラスではなく `UserNotFound` と表示されます。

```ts
class UserNotFound extends defineError("UserNotFound", { code: "not-found", publicMessage: "ユーザーが見つかりません。" }) {}
const e = new UserNotFound("users/u9 does not exist", { cause, context: { id: "u9" } });
e instanceof UserNotFound; // true
e.name; // "UserNotFound"（リテラル型なので、エラーの union を name で絞り込める）
```

- `message` は内部向けで、ログにだけ出ます。
- `publicMessage` はクライアント向けのメッセージです。省略時は `"NOT_FOUND"` のような正規のステータス名になります。
- WARNING のエラーは、クライアントに `details` も返します。名前付きのエラー（`defineError` で作ったものと `ExternalError`）には `reason: error.name` が含まれるので、同じコードのエラー（たとえば 2 種類の `already-exists`）を区別したり、クライアント側で翻訳した文言を選んだりできます。`details` はどのエラーにも指定できるオプションで、公開される情報なので秘密情報は入れないでください。ERROR と CRITICAL のエラーは、`publicMessage` 以外をクライアントに返しません。
- `severity` は、コードが HTTP 5xx に対応する場合（`internal`、`unknown`、`data-loss`、`unimplemented`、`unavailable`、`deadline-exceeded`）は `"ERROR"`、それ以外は `"WARNING"` が既定です。ERROR と CRITICAL は Error Reporting に送られ、WARNING は送られません。
- `retryable` は、失敗したイベントを `wrapEvent` が再 throw してリトライさせるかどうかを決めます。既定は `severity !== "WARNING"` です。両者が食い違う場合に指定してください。たとえばレート制限は通知するほどではないがリトライはしたいもの、コードのバグは通知すべきだがリトライしても直らないものです。
- `securityEvent` は、クライアントに何を返すかにかかわらず、その失敗をセキュリティイベントとして actor 付きで記録します。`authz_fail` のような [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html) の名前を指定します。他人の注文へのアクセスには `not-found` を返して注文の存在を知らせず、それでも試行は記録できます。指定がなければ、`permission-denied` と `unauthenticated` は `authz_fail` として扱われます。`securityEvent: false` でこれを無効にできます。
- `error.withContext({ orderId })` で、エラーが層をさかのぼる途中に項目を追加できます。
- 一度しか使わないエラーには `new AppError(message, { code, publicMessage?, severity?, retryable?, context?, details?, cause? })` を使ってください。

## アプリ側で

`resultlog/client` は、失敗した呼び出しを画面が必要とする形に変換します。サーバー側のモジュールを import しないので、ブラウザ向けのバンドルに含めても安全です。

```ts
import { httpsCallable } from "firebase/functions";
import { parseError } from "resultlog/client";

try {
  await httpsCallable(functions, "createUser")(form);
} catch (e) {
  const error = parseError(e);
  if (error.reason === "EmailTaken") showMessage(t("emailTaken")); // エラーの名前で表示する文言を選ぶ
  else if (Object.keys(error.fieldErrors).length > 0) showFieldErrors(error.fieldErrors); // zod の issues を項目ごとに
  else if (error.retryable) showRetryButton();
  else showMessage(error.message);
}
```

- `code` は `functions/` の接頭辞を除いた Firebase のコードです。`reason` はサーバー側のエラーの名前（`"EmailTaken"`）で、`defineError` で作った WARNING のエラーについてサーバーが送ります。`message` は公開用メッセージ、`details` はサーバーが送ったその他の情報です。
- `issues` は `InvalidInput` の zod の issues、`fieldErrors` はそれを項目ごとのメッセージにしたものです: `{ "address.zip": ["Too small"] }`。フォーム全体に関する問題は `"_form"` に入ります。
- `retryable` は `unavailable`、`deadline-exceeded`、`resource-exhausted`、`aborted` のときに true です。あとでやり直せば成功するかもしれない失敗です。自動でやり直すのは、繰り返しても安全な呼び出しだけにしてください。
- `wrapRequest` で包んだ `onRequest` の関数には `parseErrorBody(await response.json())` を使います。

## 外部 API

`toExternalError(provider, error, classify?)` は、外部サービスの失敗を `ExternalError` に変換します。エラーの形を見て判定するので SDK に依存せず、ログには小さな `upstream` の要約を追加します: `status`、`code`、`type`、`requestId`（提供元のサポートへの問い合わせに使う）、`retryAfterMs`。axios の request のような巨大なオブジェクトはログに入りません。

```ts
const createIntent = (params: Stripe.PaymentIntentCreateParams) =>
  ResultAsync.fromPromise(stripe.paymentIntents.create(params), (e) => toExternalError("stripe", e));
```

| 外部の失敗 | code | severity | retryable |
|---|---|---|---|
| タイムアウト（`TimeoutError`、`AbortError`、`ETIMEDOUT`、HTTP 408 / 504） | `deadline-exceeded` | ERROR | する |
| 通信断（`ECONNRESET`、`ENOTFOUND`、`fetch failed` など） | `unavailable` | ERROR | する |
| HTTP 429 | `resource-exhausted` | WARNING | する |
| HTTP 5xx（Anthropic の 529「overloaded」を含む） | `unavailable` | ERROR | する |
| その他の HTTP 4xx（401 / 403 を含む。API キーや権限を確認） | `internal` | ERROR | しない |
| gRPC のステータス（Firestore などの Google Cloud クライアント） | 同じコード。ただし `invalid-argument`、`out-of-range`、`permission-denied`、`unauthenticated` は `internal` | コードによる | `deadline-exceeded`、`resource-exhausted`、`aborted`、`internal`、`unavailable` のとき |
| それ以外 | `internal` | ERROR | する |

ステータスは `status`、`statusCode`、`response.status`（axios）から読みます。リクエスト ID は `requestId`（Stripe）、`request_id` または `requestID`（OpenAI、Anthropic）、`x-request-id` / `request-id` ヘッダーから読みます。

提供元ごとに意味が決まっているエラーは `classify` で扱います。戻り値が既定の判定を上書きします。

**Stripe。** カードの拒否は顧客側の問題で、障害ではありません:

```ts
const toStripeError = (e: unknown) =>
  toExternalError("stripe", e, (error, upstream) =>
    upstream.type === "StripeCardError"
      ? {
          code: "failed-precondition",
          publicMessage: "カードが拒否されました。",
          // 一部の拒否コードは一般的なメッセージで伝えるよう Stripe が推奨しているため、コードはログにだけ残す
          context: { declineCode: (error as { decline_code?: string }).decline_code },
        }
      : undefined,
  );
```

**生成 AI。** レート制限、タイムアウト、「overloaded」はもともとリトライ対象です。ユーザーの入力に起因するエラーだけを対応付けます:

```ts
const toOpenAIError = (e: unknown) =>
  toExternalError("openai", e, (_error, upstream) =>
    upstream.code === "context_length_exceeded"
      ? { code: "invalid-argument", publicMessage: "入力が長すぎます。" }
      : undefined,
  );
```

**Firestore** は設定不要です。gRPC のコードがそのまま対応します。既存ドキュメントへの `create()` は `already-exists`（WARNING）になり、トランザクションの競合（`aborted`）はリトライ対象です。

**fetch** は HTTP エラーでは reject しません。ok でない `Response` をそのまま渡してください:

```ts
const getPartner = (url: string) =>
  ResultAsync.fromPromise(fetch(url, { signal: AbortSignal.timeout(5000) }), (e) => toExternalError("partner", e))
    .andThen((res) => (res.ok ? ok(res) : err(toExternalError("partner", res))));
```

## 重複イベント

イベントトリガーは少なくとも 1 回配信されます。リトライやプラットフォーム自身の都合で、1 つのイベントに対してハンドラが 2 回動くことがあります。カードへの二重課金や有料 API の二重呼び出しが困る場合は、resultlog にイベントを記憶させます。

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

- 最初の配信がイベントを**確保（claim）**し（関数名とイベント ID ごとに 1 ドキュメントを、トランザクションで書き込みます）、ハンドラを実行します。イベントの処理が済むと（受理されて終わった失敗を含みます）、確保した記録は `done` になります。再配信では、ハンドラを動かさずに `duplicate: true` を記録します。
- リトライされる失敗や、throw された例外では、確保を**解放（release）**します。そのためリトライではハンドラがもう一度動きます。
- 別のインスタンスが有効な確保を持っている間に届いた配信は、スキップしません。そのインスタンスがこの後クラッシュするかもしれないからです。`EventInFlight`（WARNING、リトライ可）を再 throw して、あとでリトライさせます。確保は `leaseMs` が過ぎると失効します。既定はタイムアウト + 60 秒（タイムアウトを設定していなければ 540 秒）で、落ちたインスタンスがイベントを永久に塞ぐことはありません。
- タイムアウトのガードで打ち切られた実行は、確保した記録を `lease` が切れるまで保持します。そのハンドラがどこかでまだ動いているかもしれないためです。プラットフォームのリトライは `EventInFlight` に当たり、あとでやり直します。
- ストア自体が失敗した場合は、その実行を失敗にして、イベントをリトライさせます。イベントを `done` にするとき・解放するときの失敗は、`handledErrors` に記録するだけです。
- イベント 1 件につき Firestore のトランザクション 1 回と書き込み 1 回がかかり、解放時には削除も 1 回かかります。ドキュメントは `_resultlog_events`（`{ collection }` で変更できます）に保存され、`expireAt` のタイムスタンプを持ちます。TTL ポリシーを設定すると Firestore が自動で削除します（ここでは実行していません）:

  ```bash
  gcloud firestore fields ttls update expireAt --collection-group=_resultlog_events --enable-ttl
  ```

- 他のストアも使えます。`IdempotencyStore`（`claim`、`complete`、`release`）を実装してください。
- これが守るのはハンドラであり、ハンドラが呼ぶ先ではありません。ちょうど 1 回でなければならない副作用には、提供元の冪等キーも併用してください。キーは `event.id` から作ります。

## リトライ

`retry(fn, options?)` は、`retryable` なエラーで失敗した呼び出しをやり直します。戻り値は、呼び出し自体と同じく `ResultAsync` です。

```ts
const getPartner = (url: string) => retry(() => fetchPartner(url), { attempts: 3, budgetMs: 3000 });
```

- 提供元が `Retry-After` を返していればその時間だけ待ち、なければジッター付きの指数バックオフで待ちます。待ち時間は `baseDelayMs` から倍々に増え、`maxDelayMs` で頭打ちになります。
- `attempts` 回に達したとき、次の待ちで `budgetMs` を超えるとき、`Retry-After` が `maxDelayMs` より長いときは諦めます。関数にはタイムアウトがあり、callable ではユーザーが待っているため、長く待つより早く失敗を返します。長い待ちが必要なイベントは、プラットフォームのリトライ（`wrapEvent` の再 throw）に任せてください。
- リトライした `retry()` と、リトライしようとして止めた `retry()` は、wide event に `retries: [{ attempts, waitedMs, outcome, stoppedBy?, repeatedRequest? }]` として残ります。待つたびにパンくずも残ります。
- 既定値: `attempts` 3、`baseDelayMs` 200、`maxDelayMs` 2000、`budgetMs` 5000

`retry()` は冪等な呼び出しにだけ使ってください。決済やメール送信をやり直すと、二重になることがあります。Stripe のように冪等キーに対応した提供元は、SDK 自身のリトライでそれを扱います。

### リトライを重ねない

リトライの層を重ねると、ただでさえ不調な提供元への呼び出しが掛け算で増えます（SDK の 3 回 × `retry()` の 3 回 × プラットフォームのリトライ）。`retry()` は 2 つの方法で重ねがけを拒否します。

**コンパイル時**には、自分でリトライすることが分かっている SDK を拒否します。Stripe（v13 以降は既定で 1 回）、OpenAI と Anthropic（既定で 2 回）です。`toExternalError("stripe", …)` で変換した呼び出しは包めません:

```ts
retry(createCharge);
// 型エラー: "stripe's SDK already retries this call. Set its own retries to 0 and pass { sdkRetriesDisabled: true }, or remove retry()."
retry(createCharge, { sdkRetriesDisabled: true }); // OK（new Stripe(key, { maxNetworkRetries: 0 }) にした上で）
```

他の提供元は、型宣言のマージで追加できます:

```ts
declare module "resultlog" {
  interface SelfRetryingProviders {
    gemini: true;
  }
}
```

**実行時**には、一覧にあるかどうかにかかわらず、あらゆる SDK・関数を対象にします。`retry()` は Node の `diagnostics_channel` で外部への HTTP リクエストを観測します。対象は fetch で送ったものと、axios や Stripe SDK が使う `http` モジュールで送ったものです。1 回の試行で同じリクエストが 2 回以上送られていたら、内側の何か（axios-retry、SDK、入れ子の `retry()`）が既にリトライしています。その場合 `retry()` は呼び出しを増やさずに止め、`stoppedBy: "internal-retry"` と繰り返されたリクエストを記録します。テスト（`NODE_ENV=test`）とエミュレータ（`FUNCTIONS_EMULATOR=true`）では代わりに例外を投げるので、本番より前に気付けます。検知は axios-retry、Stripe SDK、OpenAI SDK を使って Node 26 で、観測に使うチャネルは Node 20・22・26 で確認しています。

実行時の検知には限界があります:

- 分かるのは「実際に起きたリトライ」で、「起こり得るリトライ」ではありません。内側の層が実際にリトライしたときにだけ発動します。
- HTTP/2 のリクエスト（gRPC、つまり Firestore）や、HTTP リクエストを伴わないリトライは観測できません。
- ポーリングのように同じリクエストを意図的に繰り返す呼び出しは、リトライのように見えます。`{ allowRepeatedRequests: true }` を渡してください。
- Node は組み込みのチャネルを実験的（Experimental）扱いにしています。

## 外部への呼び出し

wide event には、その実行が行った HTTP 呼び出しの要約がホストごとに入ります。呼び出しは Node の `diagnostics_channel` で観測します。対象は fetch で行ったものと、axios や Stripe SDK が使う `http` モジュールで行ったものです。

```json
"external": {
  "api.anthropic.com": { "calls": 2, "statuses": { "200": 1, "529": 1 }, "totalMs": 5210, "maxMs": 4980 },
  "api.stripe.com": { "calls": 1, "statuses": { "200": 1 }, "totalMs": 310, "maxMs": 310 }
}
```

- `statuses` はステータスごとの応答数、`errors` は応答なしで失敗した呼び出し（タイムアウト、接続リセット、abort）の数、`pending` は実行が終わった時点でまだ応答がなかった呼び出しの数です。
- `totalMs` と `maxMs` は、応答ヘッダーが届くまでの時間です。ストリーミング応答では、最後までではなく最初のバイトが届くまでの時間になります。
- 記録するのはホストだけで、パスやクエリ文字列は記録しません。載せるのは最大 20 ホストまでです。プラットフォームのメタデータサーバーは除外します。
- 「どの呼び出しが遅かったか」「どの提供元が失敗しているか」「このリクエストで LLM を何回呼んだか」が分かります（`api.openai.com` への呼び出し回数は課金されるリクエスト数です）。ログエクスプローラではホスト名を引用符で囲みます: `jsonPayload.external."api.openai.com".calls>2`
- 観測できないもの: HTTP/2 を使う gRPC（つまり Firestore）と、HTTP 以外の通信です。要約を無効にするには `configure({ recordExternalCalls: false })` を指定します。
- インスタンスで最初の実行には `coldStart: true` も付きます。遅いのが起動のせいかコードのせいかを切り分けられます。コールドスタートのログはサンプリングで間引かれません。

## LLM の呼び出し

LLM の呼び出しは遅く、課金され、エラーなしに失敗することがあります。回答が途中で切れたり、差し控えられたりするからです。レスポンスを `logContext.llm` に渡すと、その呼び出しが何を使ったかがエントリに残ります。

```ts
const completion = await client.chat.completions.create({ model: "gpt-4o-mini", messages });
logContext.llm(completion); // `completion` をそのまま返すので、チェーンの中でも使えます: .andTee((res) => logContext.llm(res))
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

**ここには提供元やモデルの一覧がありません。** resultlog は、キーの名前が言っていることからレスポンスを読みます。トークン数を表すキーで、`input` または `prompt` とあれば入力トークン、`output`・`completion`・`candidates` とあれば出力トークン、`cache` とあればキャッシュされたトークン（`creat…` / `writ…` ならキャッシュへの書き込み）、`reason…` や `thought…` とあれば推論トークンです。`usage`（または `usageMetadata`）オブジェクトをレスポンスの上のほうから探し、`model`（`modelId`、`modelVersion` も）と `finish_reason` / `stop_reason` / `finishReason` も同じように探します。最初に見つかったものを採用します。OpenAI（chat completions と responses）、Anthropic、Gemini、Vercel AI SDK、Bedrock Converse、Cohere のレスポンスの形で確認していて、同じ語彙を使う SDK なら変更なしで動きます。

- **数値は提供元の報告のまま記録します。** OpenAI はキャッシュされたトークンを入力トークンの内数として数え、Anthropic は別枠で数えます。resultlog はこの違いを調整しません。
- **読み取れないものは自分で渡します。** `logContext.llm(response, { model: "my-alias", inputTokens: 1200 })` のように渡すと、渡した値が優先されます。何も読み取れなかった呼び出しは `unrecognized` に数えられるので、知らない形のレスポンスが黙って見落とされず、ログに現れます。
- **途中で切れた回答と、差し控えられた回答。** 容量の不足を表す終了理由（`length`、`max_tokens`）は `truncated`、フィルタ・安全性・拒否を表す終了理由（`content_filter`、`SAFETY`、`refusal`）は `blocked` に数えます。どちらも `200` で返る不良な回答で、エラーにはなりません。こうした実行はサンプリングで間引かれません。
- **費用は自分の関数から計算します。** 価格表は内蔵していません。価格は変わりますし、契約によっても異なるからです。1 回の呼び出しの価格を返す関数を `configure` に渡してください。単位は自由で、価格を決められない呼び出しには undefined を返します:

  ```ts
  const PER_MILLION = { "gpt-4o-mini": [0.15, 0.6] } as const; // 自分で管理する
  configure({
    price: ({ model = "", inputTokens = 0, outputTokens = 0 }) => {
      const rates = PER_MILLION[model as keyof typeof PER_MILLION];
      return rates && (inputTokens * rates[0] + outputTokens * rates[1]) / 1e6;
    },
  });
  ```

  `llm.cost` はその実行の合計です。`jsonPayload.llm.cost` にログベースの指標を作れば支出の推移が分かり、それにアラートを付ければ支出の警報になります。
- **ストリーム。** ストリームそのものを渡し、返ってきたものを反復します:

  ```ts
  for await (const chunk of logContext.llm(stream)) send(chunk);
  ```

  チャンクはそのまま流れ、エラーも今までどおり届きます。エントリには、チャンク全体から集めた数値（提供元は累計を送るので、最大の値を採用します）、`ttftMs`（ストリームを渡した時点からの時間なので、リクエストが返ったらすぐ渡してください）、そしてストリームが失敗した場合や途中で読むのをやめた場合の `interrupted` が入ります。Anthropic の `finalMessage()` のように最終メッセージを返す SDK のストリームは、完了後にその最終メッセージを渡すこともできます。
- **フォールバック。** `fallback(primary, secondary)` は試行を順に実行し、失敗が `retryable`（提供元の側の問題）のときだけ次へ進みます。リクエスト自体が誤っているなら、次の提供元でも拒否されるからです。見送った試行は `handledErrors` に `{ fallback: 0, error }` として記録し、最後の結果はそのまま返します:

  ```ts
  const answer = fallback(
    () => ResultAsync.fromPromise(anthropic.messages.create(params), (e) => toExternalError("anthropic", e)),
    () => ResultAsync.fromPromise(openai.chat.completions.create(other), (e) => toExternalError("openai", e)),
  ).andTee((res) => logContext.llm(res));
  ```

  試行ごとに `retry()` と組み合わせることもできます: `fallback(() => retry(primary), secondary)`
- **含まれないもの。** 提供元ごとのエラー一覧: エラーはそれ自身が語ること（ステータス、`Retry-After`、gRPC コード、ネットワークエラー）で分類し、提供元に固有のものは `toExternalError` の `classify` で扱います。ユーザーごとの支出上限: ストアと方針が必要なので、利用者に任せています。プロンプトと応答は自動では記録しません。パンくず（`logContext.debug`）は失敗時にだけ出力されるので記録先として妥当ですが、パターンでは自由記述の個人情報を見分けられません。

## セキュリティ監査と調査

resultlog は、不正アクセスの調査に必要なログを書き出し、振り分けや通知が安く済むようにラベルを付けます。`logging.googleapis.com/labels` フィールドは、Cloud Logging ではエントリの `labels` になります。

- **実行者（actor）。** ラップした実行ごとに、リクエストした人の情報を記録します: `uid`、`signInProvider`、`authTime`（サインインした時刻）、App Check の `appId` と `appCheck`（`verified`、`missing`、使用済みのトークンなら `replayed`）、`ip`、`forwardedFor`（`X-Forwarded-For` の生の値）、`userAgent`。actor は監査ログとセキュリティログに書き出します。通常のトラフィックで 1 アカウントが多数のアドレスから使われているかを digest が見られるよう、全エントリに載せたい場合は `configure({ actor: "all" })` を使います（[誰が呼んだか](#誰が呼んだか)を参照）。`onRequest` では、自分で検証した uid を `logContext.setActor({ uid })` で追加してください。
- **セキュリティイベント。** [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html) の名前と `security` ラベルを使います。`unauthenticated` と `permission-denied` は `securityEvent: "authz_fail"`、不正な入力は `"input_validation_fail"`、再利用された App Check トークンは `"authn_token_reuse"` として記録します。エラーに `securityEvent` で独自の名前を宣言でき、何も失敗していない場所では `logContext.security()` で記録できます。[不正アクセスの検知](#不正アクセスの検知)を参照してください。
- **監査証跡。** `logContext.audit(event, data?)` は、actor と `audit` ラベル付きの NOTICE ログをその場で書き出すので、タイムアウトしても消えません。実行の最後のログにも同じイベントが `auditEvents` として結果とともに残ります。当てはまるものは OWASP の名前を使ってください: `authz_change`、`authz_admin`、`sensitive_read`、`sensitive_update`、`sensitive_delete`、`user_created`、`user_deleted`
- **IP アドレス**は、他の情報と組み合わせると個人情報になり得ます（OWASP も注意しています）。これらのログはアクセス権を絞ったバケットに保管してください。`X-Forwarded-For` の左側の値はクライアントが付けたもので偽装できます。Google のフロントエンドが右側に付け足した値は信頼できます。
- **認証チェックはハンドラ内で。** `onCall` の `authPolicy` で弾かれた呼び出しはハンドラに届かないため、拒否が記録されません。記録したい場合は、ハンドラ内でチェックして `HttpsError("permission-denied", …)` を throw してください。

監査ログの例:

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

### 管理アクティビティ監査ログと一緒に保管する

GCP は、プロジェクトに対する管理操作（IAM ポリシーの変更、サービスアカウントキーの作成、関数のデプロイなど）を管理アクティビティ監査ログとして自動で記録しています。常に有効で、無料で、`_Required` バケットに 400 日保持されます。インシデントを 1 か所で調査できるよう、resultlog の監査ログ・セキュリティログと一緒に専用のバケットへコピーします:

```bash
PROJECT_ID=your-project
gcloud logging buckets create security-audit --location=global --retention-days=400
gcloud logging sinks create security-audit \
  "logging.googleapis.com/projects/$PROJECT_ID/locations/global/buckets/security-audit" \
  --log-filter='labels.audit="true" OR labels.security:* OR logName:"cloudaudit.googleapis.com%2Factivity"'
```

コピーは取り込み量として課金されますが、管理アクティビティの量はわずかです。改ざんされにくくするには、バケットをロックします。**ロックは取り消せません。** ロック後は誰もバケットを削除したり保持期間を短くしたりできなくなります。

```bash
gcloud logging buckets update security-audit --location=global --locked
```

通知の設定にコードは不要です:

- 拒否の回数を数える: `gcloud logging metrics create authz-fail --log-filter='labels.security="authz_fail"'` を実行し、その指標に Cloud Monitoring のアラートを設定します（例: 5 分間に 20 回を超えたら通知）。
- 危険な管理操作を見張る: ログベースのアラートを作り、フィルタを `protoPayload.methodName:"SetIamPolicy" OR protoPayload.methodName="google.iam.admin.v1.CreateServiceAccountKey"` などにします。

ログエクスプローラでの調査クエリ:

- あるユーザーの操作すべて: `jsonPayload.actor.uid="UID" OR jsonPayload.authUid="UID"`
- ある IP からのアクセスすべて: `jsonPayload.actor.ip="203.0.113.5"`
- ある管理者による管理操作: `protoPayload.authenticationInfo.principalEmail="someone@example.com"`

Firestore の読み書きをすべて記録するデータアクセス監査ログは既定で無効で、量が非常に多くなりがちです。重要な操作の記録には、resultlog の監査イベントの方がはるかに安く済みます。

## 不正アクセスの検知

resultlog は、関数から見えるものを、セキュリティツールが期待する形で記録します。[OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html) の名前をつけたイベントに、actor と `security` または `audit` のラベルを付けます。これらに通知を設定し、背後にいる実行者を探すのは、Cloud Monitoring と `resultlog digest` の役目です。OWASP は 2025 年にこのリスクの名前を「Security Logging and Alerting Failures」に改めました。通知のないログに価値はほとんどない、という考え方です。

### 関数から見えるものと見えないもの

- **Firebase は、失敗したサインインを関数に見せません。** Identity Platform の監査ログは、サインインの呼び出し（`SignInWithPassword` など）を記録せず、ブロッキング関数が動くのは認証情報の検証に成功した後だけです。サインインに対するブルートフォースやクレデンシャルスタッフィングは、Firebase Authentication 自身の保護、MFA、reCAPTCHA Enterprise、そして自分のエンドポイントの前段では Cloud Armor の領域です。
- **関数から見えるもの:** 拒否された呼び出しや不正な呼び出しとその実行者、成功したサインイン（`wrapBlocking` を使う場合）、そしてアカウントがその後に行うこと。

### 記録されるもの

- `authz_fail`: `permission-denied` と `unauthenticated` は自動で、宣言したエラーも記録されます。他人の注文へのリクエストには 404 を返しながら、記録は残せます。

  ```ts
  class OrderNotFound extends defineError("OrderNotFound", { code: "not-found", securityEvent: "authz_fail" }) {}
  // 所有者チェックに失敗: クライアントには NOT_FOUND、ログには authz_fail と actor と注文 ID が残る
  return err(new OrderNotFound(`orders/${id} belongs to someone else`, { context: { orderId: id } }));
  ```

- `input_validation_fail`: zod のスキーマが入力を拒否した。
- `authn_token_reuse`（CRITICAL）: 使用済みの App Check トークン。重要な callable では `consumeAppCheckToken: true` でリプレイ保護を有効にします（Node.js SDK のベータ機能で、呼び出しごとにラウンドトリップが 1 回増えます）。resultlog はリプレイを記録し、actor の `appCheck` は `verified`、`missing`、`replayed` のいずれかになります。リクエストを拒否するかどうかはあなたの判断か、`enforceAppCheck` の役目です。
- `authn_login_success`、`user_created`、`authn_login_fail`: 下の `wrapBlocking` が記録します。
- ほかに記録を残したいもの: 失敗ではないイベントには `logContext.security("sensitive_read", { collection })`、管理上の変更には `logContext.audit("authz_change", { target })`。1 つのイベントはどちらか一方で記録してください。

### 誰が呼んだか

監査ログとセキュリティログには `actor` が付きます。`configure({ actor: "all" })` にすると全エントリに付き、digest のアカウント別・アドレス別のルールが通常のトラフィックを見られるようになります。検討すべき点が 2 つあります。1 エントリあたり 100〜250 バイト増えること、そして IP アドレスと uid は多くのプライバシー法で個人情報にあたるため、これらのログの保持期間を短くし、読める人を絞ることです。`successSampleRate` が 1 未満だと、digest が見られる通常のトラフィックは一部だけになります。

### サインイン: wrapBlocking

```ts
import { beforeUserSignedIn } from "firebase-functions/v2/identity";

export const onSignIn = beforeUserSignedIn(
  wrapBlocking((event) => (isDenied(event.ipAddress) ? err(new BlockedAddress("on the deny list")) : ok({ sessionClaims: { plan: "free" } }))),
);
```

- 通ったサインインはすべて監査イベント `authn_login_success`（サインアップは `user_created`）として、アドレス、ユーザーエージェント、サインイン方式とともに記録されます。`AppError` を返すとサインインを拒否します。Firebase には `HttpsError` が渡り、ログには `authn_login_fail`（エラーが `securityEvent` を指定していればそれ）が残ります。成功時に `fn` が返したもの（カスタムクレーム、`disabled` など）は Firebase に渡されます。
- プロジェクトを Identity Platform 付きの Firebase Authentication にアップグレードしている必要があります。Firebase はブロッキング関数に 7 秒を与えるので、ここではグローバルのタイムアウトにかかわらず、タイムアウトのガードの既定が 7 秒になります。
- ポリシーが壊れた（例外、タイムアウト）場合は、サインインを拒否します。ブロッキング関数が壊れると全員がサインインできなくなるため、`failOpen: true` を指定すると、失敗を記録した上でサインインを通します。ポリシーが意図して返した拒否は、常に尊重されます。
- 認証情報の検証が済んだ後に動くので、間違ったパスワードはここには来ません。Auth エミュレータでは、アドレスとユーザーエージェントは仮の値です。

### アラート

- **実行者ではなくイベントで数える。** ログベース指標のラベルは最大 10 個、時系列は約 3 万までで、Google はユーザー ID や IP アドレスをラベルに取り出すことを勧めていません。ユニークな値はすべて課金対象になり、スロットリングされることもあります。ラベルにはイベントを使い、実行者は digest やログのクエリで探します。`resultlog monitoring` は、この方針で指標とアラートを生成します（[Cloud Monitoring](#cloud-monitoring)を参照）。セキュリティイベントをイベントごとのラベルで数える指標、急増したときのアラート、そして再利用された App Check トークンのように稀で重大なイベントには、エントリ自体に反応するログベースのアラートです。
- **実行者別・アドレス別は digest で。** 下のルールにはアカウント別・アドレス別の件数が必要です。これは指標に載せてはいけないものです。すでにある定期実行の仕組み（cron、CI のスケジュール）で `resultlog digest` を回して検知結果を読んでください。調査中は手動でも同じことができます。

| ルール | 見るもの | 既定 | 重大度 |
|---|---|---|---|
| `authz-probing` | 1 実行者による `authz_fail` | 5 分間に 10 件 | medium |
| `validation-fuzzing` | 1 実行者による `input_validation_fail` | 5 分間に 20 件 | medium |
| `many-accounts-one-ip` | 1 つのアドレスから見えた異なるアカウント（クレデンシャルスタッフィング、スプレー、アカウント量産、またはオフィスの NAT） | 60 分間に 5 件 | medium |
| `many-ips-one-account` | 1 つのアカウントの異なるアドレス（認証情報の共有、乗っ取り、または移動中のユーザー） | 60 分間に 4 件 | medium |
| `mass-access` | 1 アカウントによる `sensitive_read` の監査イベント（スクレイピング、持ち出し） | 10 分間に 100 件 | high |
| `token-reuse` | `authn_token_reuse` | 1 件 | high |
| `privilege-change` | 権限やアカウントの変更の監査イベント | 1 件 | info |
| `privilege-change-by-non-admin` | 同じ変更を `--admins` にない uid が行った | 1 件 | high |

ルールはデータで、fail2ban や CrowdSec と同じ形をしています。数える対象のエントリ（`filter`）を `key` ごとに、エントリとして、または異なる値（`distinct`）として数え、`windowMs` の間に `threshold` に達したら報告します。独自のルールを追加できます:

```ts
import { digest } from "resultlog/digest";

const { data } = digest(logs, {
  rules: [
    {
      name: "night-admin",
      severity: "medium",
      summary: "夜間に管理上の変更が行われた。",
      hint: "本人によるものか、管理者に確認する。",
      filter: (p) => p.kind === "audit" && new Date(p.time ?? 0).getUTCHours() < 5,
      key: (p) => p.uid,
      threshold: 1,
    },
  ],
});
```

### 何か見つかったら

- **アカウントを止める。** Admin SDK でリフレッシュトークンを失効させ、必要なら無効化します（`getAuth().revokeRefreshTokens(uid)`、`updateUser(uid, { disabled: true })`）。発行済みの ID トークンは、コード側で失効を確認しない限り、期限が切れるまで有効です。セッションの失効については Firebase のガイダンスを確認してください。
- **ブロックは短く、手前で。** 分散型の攻撃では攻撃者が同じアドレスを再利用することはまれなので、長期ではなく 15 分以内でブロックします（Datadog の推奨）。関数の中ではなく、Cloud Armor など関数の前段で行います。
- **使われた穴を塞ぐ。** 欠けていた所有者チェックを直し、`enforceAppCheck` とリプレイ保護を有効にし、読まれた可能性のある秘密情報をローテーションします。
- **証拠を残す。** digest とエントリを、改ざんできないバケットに保管します（[管理アクティビティ監査ログと一緒に保管する](#管理アクティビティ監査ログと一緒に保管する)を参照）。

### resultlog がやらないこと

- **ペイロードの攻撃文字列のスキャン。** パターンの一覧になり、誤検知が多くなります。Cloud Armor や Arcjet のほうが適しています。
- **レート制限とロックアウト。** 共有の状態が必要で、攻撃者が Firestore のカウンタを課金に変えることもできます。手前で行ってください: App Check、reCAPTCHA Enterprise、Cloud Armor、または Arcjet や Upstash のような専用のサービス。
- **位置情報、IP の評判、端末のフィンガープリント。** resultlog が持っていないデータが必要です。
- **実際のプロジェクトでは未確認:** ラベルの変換、アラート、本番の Identity Platform（ブロッキング関数は Auth エミュレータでのみ確認しました）。


## Cloud Monitoring

resultlog のエントリは、Cloud Logging と Cloud Monitoring で読み、アラートを掛けられるように作ってあります。下のレシピでコンソールから手作業で設定することも、`resultlog monitoring` で設定一式をファイルとして書き出すこともできます。

### コンソールで手作業で

**1 種類のエントリにアラートを掛ける。** Logs Explorer で下のクエリのどれかを実行し（各見出しの下の行がクエリです）、**Actions → Create log alert** を開いて、名前、重大度、通知の間隔、通知先を入力します（メニュー名は英語表示のものです）。ログアラートはエントリそのものに反応して通知するので、稀で重大なイベントに向いています。件数は数えられません。「5 分間に 5 回を超えたら」のような条件には、同じフィルタでログベース指標を作り、その指標にアラートを掛けてください（下のコマンドは 9 個書き出します）。ログアラートは、除外フィルタで捨てられたログを見ません。

```text
# サーバー側の失敗（ERROR 以上）
resource.type="cloud_run_revision" AND severity>=ERROR AND jsonPayload.errorName:*

# 5xx の応答（プラットフォーム自身のものを含む）
resource.type="cloud_run_revision" AND httpRequest.status>=500

# 再利用された App Check トークン
resource.type="cloud_run_revision" AND jsonPayload.securityEvent="authn_token_reuse"

# 権限やアカウントの変更
resource.type="cloud_run_revision" AND jsonPayload.auditEvent=~"^(authz_(change|admin)|privilege_|user_(created|updated|archived|deleted))"

# タイムアウトで打ち切られた関数
resource.type="cloud_run_revision" AND jsonPayload.errorName="DeadlineExceeded"

# 途中で切れた・差し控えられた・中断された LLM の回答
resource.type="cloud_run_revision" AND (jsonPayload.llm.truncated>0 OR jsonPayload.llm.blocked>0 OR jsonPayload.llm.interrupted>0)
```

特定の失敗が再発したときに通知を受けるには、最初のフィルタに `AND jsonPayload.fingerprint="…"` を足します。fingerprint は digest とエントリに載っています。どのフィルタも `AND resource.labels.service_name="getuser"` を足せば、1 つの関数に絞れます。

**行に情報を足す。** Logs Explorer はエントリを 1 行とチップで表示します。**Preferences → Manage summary fields** で `jsonPayload.errorName`、`jsonPayload.durationMs`、`jsonPayload.authUid`、`jsonPayload.securityEvent` を追加し、**Apply** を押します。すると各行に、メッセージの横に失敗の種類、所要時間、呼び出した人、セキュリティイベントが表示されます。これは表示の設定で、ログに出力される内容は変わりません。

### ファイルとして書き出す

`resultlog monitoring` は、ログベース指標、アラートポリシー、ダッシュボードを、`gcloud` が受け取る JSON として書き出します。書き出すのはファイルだけで、Google Cloud にはつながりません。ファイルを読んで確かめたうえで、同じ場所に書き出される `README.md` にあるコマンドで適用してください。

```bash
npx resultlog monitoring --project my-project \
  --notification-channel projects/my-project/notificationChannels/1234567890
```

通知チャネルの名前は `gcloud beta monitoring channels list --format='value(name,displayName)'` で調べられます。`--notification-channel` を指定しない場合、アラートはチャネルなしで作成されるので、コンソールで追加してください。

### 作られるもの

- **ログベース指標 9 個**（すべてカウンタ）: 失敗（エラー名、エラーコード、重大度別）、セキュリティイベントと監査イベント（種類別）、タイムアウト、コールドスタート、重複イベント、途中で切れた・差し控えられた・中断された LLM の回答。ラベルが取る値は意図的に少なくしています。ユーザー ID やアドレスをラベルにすると、値ごとに時系列が増えて課金されます。
- **アラートポリシー 6 個**。それぞれ、何を意味するか、どうするか、digest でどう詳しく調べるかをドキュメントに書いています。
  - **サーバーエラー**: 1 つの関数で 5 分間に 5 回を超えた場合（ERROR 以上。not-found のような想定内の失敗は数えません）
  - **セキュリティイベントの急増**: 同じ種類が 5 分間に 20 回を超えた場合
  - **App Check トークンの再利用**と**権限やアカウントの変更**: ログベースのアラートで、エントリ自体に反応して通知します（5 分間に最大 1 回）。稀なイベントなので、期間の件数で数えると埋もれてしまうためです。
  - **関数のタイムアウト**: 10 分間に 3 回を超えた場合
  - **LLM の回答が切れた・差し控えられた・中断された**: いずれかが 10 分間に 5 回を超えた場合
- **ダッシュボード**「resultlog: functions」: Cloud Run 自身のリクエスト数とレイテンシ（p50、p95）、続いて resultlog の指標（失敗、セキュリティイベント、監査イベント、タイムアウト・重複・コールドスタート、LLM の問題）、そしてエントリを一覧するパネルが 2 つ（セキュリティと監査のエントリ、失敗）。

オプション: `--service checkout,on-order` はその関数だけを対象にします（Cloud Run のサービス名で指定します。関数名を小文字にしたものです）。`--threshold errors=10` はアラートのしきい値を変えます（`errors`、`security-events`、`timeouts`、`llm-problems`）。`--prefix` は名前の接頭辞、`--out` は出力先（既定 `./monitoring`）です。出力先に生成される `README.md` に、各ファイルの説明があります。

### 適用

生成される `README.md` に、プロジェクト ID 入りのコマンドがあります。要点は次のとおりです。出力先のディレクトリで、1 回だけ実行します:

```bash
for f in metrics/*.json; do gcloud logging metrics create "$(basename "$f" .json)" --config-from-file "$f"; done
for f in alerts/*.json; do gcloud monitoring policies create --policy-from-file "$f"; done
gcloud monitoring dashboards create --config-from-file dashboard.json
```

`policies create` と `dashboards create` は、もう一度実行すると同じものをもう 1 つ作ってしまいます。あとで何かを変えるとき（たとえばしきい値。`--threshold errors=10` を付けて生成し直します）は、作り直さず置き換えてください。`gcloud logging metrics update NAME --config-from-file FILE` は指標を更新します。`gcloud monitoring policies update POLICY --policy-from-file FILE` はポリシーをその場で置き換えるので、インシデントの履歴は残りますが、コンソールで加えた変更も含めて全体が置き換わります。POLICY は `gcloud monitoring policies list` で調べます。ダッシュボードはファイルだけでは更新できない（現在の etag が必要）ので、削除してから作り直します。`dashboards create` に `--validate-only` を付けると、保存せずに Google にファイルを検証させられます。

コードからは `import { monitoring, files } from "resultlog/monitoring"` を使います。`monitoring(options)` は指標・アラート・ダッシュボードを普通のオブジェクトで返すので、Terraform、Pulumi、CDK でリソースを組み立てるのに使えます。`files(options)` はコマンドが書き出すファイルの一式を返します。

### 知っておくこと

- **指標が数えるのはログのエントリです。** 失敗、セキュリティイベント、監査イベントは必ずログに出るので、その件数は完全です。通常の成功はサンプリングで間引かれることがあります（`successSampleRate`）。ダッシュボードのリクエストのグラフが Cloud Run 自身の指標を使うのはそのためです。
- **ユーザー別・アドレス別は指標に入っていません。** それは digest で調べてください。
- **費用。** ユーザー定義のログベース指標は Cloud Monitoring の料金で課金され、ラベルの値ごとに時系列が増えます。生成されるラベルはイベント名、エラー名、重大度です。ID を持つラベルは追加しないでください。
- **第 2 世代の関数のみ対象です。** フィルタは `resource.type="cloud_run_revision"` を選びます。
- **実際のプロジェクトには適用していません。** ファイルは Google の API リファレンスに従っていて、フィルタはライブラリが実際に書き出すエントリに対してテストしていますが、実プロジェクトに適用した人はまだいません。まず `dashboards create --validate-only` で検証し、最初の実行の出力を確認してください。フィールドの調整が 1、2 か所必要になるかもしれません。


## AI アシスタントと調べる

各エントリは、1 回の実行について、それ自体で意味が分かる記録です。項目名は安定していて、秘密情報はすでにマスクされ、失敗の種類を表す `fingerprint` が付きます。そのため AI アシスタントが読みやすく、`resultlog digest` を使えば渡せる大きさにまとめられます。

```bash
gcloud logging read 'resource.type="cloud_run_revision"' --freshness=1d --limit=3000 --format=json \
  | npx resultlog digest --pseudonymize > digest.md
```

できあがった `digest.md` をアシスタントに渡して、たとえばこう頼みます: 「昨日の関数のダイジェストです。どの失敗グループから直すべきか、考えられる原因、次に確認することを教えてください。」

digest は `gcloud logging read` の出力（JSON の配列、またはログのエクスポートのような 1 行 1 JSON）を読み、次のものを報告します。

- **検知結果（findings）**: 検知ルールが見つけたものを重大なものから順に、根拠と次の一手とともに表示（[不正アクセスの検知](#不正アクセスの検知)を参照）
- 期間、エントリ数と重大度、実行回数。サンプリングで残った成功は重みを掛けて数えるので、割合が狂いません。
- 関数ごとの実行回数、失敗率、所要時間の p50 と p95、コールドスタート
- **失敗グループ**（`fingerprint` ごと）: 件数、関数、時間帯、リトライ可否、メッセージ、失敗した外部呼び出し、パンくず、トレース ID、短くしたサンプルエントリ
- **セキュリティ**: 種類ごとのイベント、その背後にいる実行者（uid、アドレス、ユーザーエージェント）、最も多かった 1 分間、監査イベント
- 失敗率と遅さの順に並べた外部ホスト、モデルごとの LLM のトークン数と費用（途中で切れた・差し控えられた・中断された呼び出しを含む）、そしてタイムアウト、重複イベント、回復済みエラー、リトライが止まった理由

オプション: `--format json` で同じデータを JSON で出力、`--top N` で各リストの件数、`--max-chars N`（既定 20,000）で Markdown の上限を厳守します。上限の範囲では、どのセクションにも最初の 1 件を先に割り当ててから 2 件目に進むため、特定のセクションが他を押しのけることはなく、削った件数は表示されます。失敗率や所要時間のパーセンタイルが欲しい場合は、エクスポートに INFO のエントリも含めてください。`severity>=WARNING` だと、digest には失敗しか見えません。

検知のオプション: `--admins uid1,uid2`（権限やアカウントを変更してよい uid。それ以外による変更は high の検知結果になります）と、ルールのしきい値を変える `--threshold rule=N`（繰り返し指定可）。コードからは `digest(logs, { admins, thresholds, rules })` で、独自のルールも渡せます。

**プライバシー。** digest には uid、IP アドレス、ユーザーエージェントと、メッセージに書かれた内容が含まれます。管理できないサービスに貼り付ける前に `--pseudonymize` を付けてください。この 3 つが安定した仮名（`user_7b4ae8`）に置き換わり、パターンは見えたまま、実行のたびに仮名は変わります。自由記述（メッセージや、自分で付けた属性）は変換されません。これも、属性に個人情報を入れない理由のひとつです。

コードからは `import { digest, parseLogs } from "resultlog/digest"` を使います。`parseLogs(text)` は `{ logs, skipped }` を返し、`digest(logs, { top, maxChars, pseudonymize })` は `{ data, markdown }` を返します。

**フィンガープリント。** `fingerprint` は、失敗の種類を表す 16 進 12 文字です。エラーの名前とコード、発生箇所（関数名とファイル名。行番号は含まないので、デプロイしても変わりません）、外部の失敗なら提供元とステータスの分類（500 と 503 はどちらも `5xx`）から作ります。メッセージには ID が含まれるので使いません。ログエクスプローラでは `jsonPayload.fingerprint="b49c01a8ca7b"` のように検索できます。

**AI コーディングアシスタント向け。** パッケージには `llms.txt` が含まれています。API の要約、使い方の決まり、ログの項目の辞書です。アシスタントのコンテキストに `node_modules/resultlog/llms.txt` を加えてください（Claude Code なら `@node_modules/resultlog/llms.txt`）。

## ログの費用

Cloud Logging は、毎月プロジェクトあたり最初の 50 GiB を超えた取り込みに 1 GiB あたり $0.50 を課金します。これには 30 日間の保持が含まれ、それより長く保持する場合は 1 GiB・1 か月あたり $0.01 かかります。

- **主な節約効果**は、処理の段階ごとに 1 行ではなく 1 実行 1 エントリにすること、そして DEBUG パンくずを失敗時にだけ書き出すことです。
- **サンプリング。** 速く終わった成功ログを一部だけ残します:

  ```ts
  configure({ successSampleRate: 0.1, slowMs: 1000 }); // 1 秒未満で終わった成功は 10% だけ残す
  ```

  失敗、`slowMs` より遅い実行、監査イベントのある実行、回復済みエラーのある実行、重複イベント、コールドスタート、途中で切れた・差し控えられた・中断された LLM 呼び出しのある実行は常に記録します。サンプリングで残ったログには `sampleRate` が付くので、集計時は件数を `1 / sampleRate` 倍してください。
- **サイズ上限。** 2,000 文字を超える文字列と 100 要素を超える配列は切り詰め、5 階層より深い値は `"[Truncated]"` にします。Cloud Logging は 256 KB を超えるエントリを受け付けないため、100 KB を超えたエントリは主要な項目（エラー名とコード、actor、所要時間など）と `truncatedBytes` だけに置き換えます。
- **全エントリへの actor**（`configure({ actor: "all" })`）は、1 エントリあたり 100〜250 バイト増えます。成功ログをサンプリングで間引く（`successSampleRate`）と、digest が見られる通常トラフィックも薄くなります。
- **`httpRequest` と `context`。** callable と HTTP 関数の `httpRequest` は、そのエントリごとに約 90 バイト増え、ERROR の `context` はさらに約 90 バイト増えます。月 300 万回の実行なら約 0.25 GiB です。actor が出る場所では、アドレスとユーザーエージェントが `actor` に加えて `httpRequest`（ERROR では `context` にも）に書かれるので、ユーザーエージェントが長いと数百バイトさらに増えます。どちらも Logs Explorer と Error Reporting が自分で読む標準のフィールドです。オフにする設定はありません。
- **見積もり。** 月間のエントリ数 × 平均サイズで計算します。たとえば 1 回あたり約 1 KB の実行が月 300 万回なら約 3 GiB で、無料枠の 50 GiB に十分収まります。
- **プラットフォームのリクエストログ。** Cloud Run は HTTP 呼び出しごとにリクエストログ（`run.googleapis.com/requests`）も書き出し、その内容は wide event と大部分が重複します。`logName:"run.googleapis.com%2Frequests" AND httpRequest.status<400` のような除外フィルタで成功分を落とせます。料金ページではログバケットへの取り込みに課金すると定義されているので、除外したログは課金されないはずです。実際の請求で確認してください。callable と HTTP 関数の wide event にも同じステータスとレイテンシの `httpRequest` が付くので、`httpRequest.status>=500` のクエリは、関数が返した応答を引き続き見つけられます。残しておくリクエストログ（ステータス 400 以上）には、コードではなくプラットフォームが応答したケースも含まれます。なお、監査ログ以外の通常のリクエストでクライアント IP が残るのは、このリクエストログだけです。

## マスキング

次の 2 つをマスクします。対象は階層の深さにかかわらず、属性、エラーの context、パンくずの data、cause、ログのメッセージ自体です（SDK のエラーメッセージには、拒否したキーが引用されていることがよくあります）。

- **キー名による判定。** キー名が `/password|secret|token|authorization|cookie|api[-_]?key/i` に一致する値は `"[REDACTED]"` になります。トークンの*数*は秘密ではないため、`max_tokens`、`inputTokens`、`promptTokenCount` のようなキーの数値と、`…_tokens_details` オブジェクトは対象外です。`token`、`accessToken`、`tokens` という名前のリストはマスクされます。
- **パターンによる判定。** 文字列のどこにあっても検出します。
  - JWT（`[REDACTED:jwt]`）と、16 文字以上の `Bearer` トークン
  - API キー: Stripe（`sk_live_`、`rk_`、`whsec_`）、OpenAI と Anthropic（`sk-…`）、Google（`AIza…`）、AWS のアクセスキー ID（`AKIA…`）、GitHub と Slack のトークン（いずれも `[REDACTED:key]`）
  - 秘密鍵のブロック（`[REDACTED:private-key]`）
  - URL のクエリ文字列に含まれる秘密情報（`api_key=…`、`token=…`、`key=…`、`signature=…`、`password=…`）
  - Luhn チェックを通るカード番号（Visa、Mastercard、Amex、Discover、JCB）（`[REDACTED:card]`）。チェックとカードの先頭桁の条件で、タイムスタンプや ID をカードと取り違えないようにしています。
- **独自のパターン。** `configure({ secretPatterns: [/internal-\d{6}/] })` で追加できます。置き換え後は `[REDACTED:custom]` になります。

パターンは、キー名では拾えないもの（プロンプト、URL、エラーメッセージの中のキーなど）を捕まえます。ただしデータ損失防止（DLP）の代わりにはなりません。氏名、メールアドレス、自由記述の個人情報は検出しないので、ログ、とくに `logContext.set` には入れないでください。カード番号の条件を偶然満たす長い数字の ID は、誤ってマスクされることがあります。

循環参照は `"[Circular]"`、`bigint` は文字列になります。`toJSON` を持つオブジェクト（日付、axios のエラー、Firestore のタイムスタンプ）はその結果を書き出し、それ以外のクラスのインスタンスは自身のプロパティを書き出します。

## 制限事項

- 記録されるのは、ラップしたハンドラ内の処理だけです。
- `wrapEvent` がエラーを再 throw すると、Functions のランタイム側でも同じエラーがログに出ることがあり、Error Reporting で 2 回数えられる場合があります。
- タイムアウトのガードは、遅い実行に代わって応答しますが、その処理自体は止められません。中断できる呼び出しには `logContext.signal` を渡してください。
- スタックトレースが残るのは、返したり throw したりしたものが `Error` の場合だけです。文字列ではなく `AppError` のサブクラスを返してください。
- resultlog が書き出す項目（`actor`、`auditEvent`、`auditEvents`、`securityEvent`、`securityEvents`、`httpRequest`、`context`、`errorName`、`errorCode`、`fingerprint`、`publicMessage`、`retryable`、`durationMs`、`breadcrumbs`、`cause`、`sampleRate`、`handledErrors`、`retries`、`external`、`llm`、`coldStart`、`duplicate`、`provider`、`upstream`）は、同じ名前の属性を上書きします。

## 開発

```bash
npm ci                 # ロックファイルは npm のもの。Bun はテストの実行にだけ使います
bun test
npm run typecheck
npm run build          # dist/esm と dist/cjs
npm run smoke          # ビルドを、実行中の Node で動かす
npm pack --dry-run     # 公開した場合に含まれるもの
```

ソースは `src/` に、関心ごとに 1 モジュールずつ分けてあります。構成、規約、リリースの手順は `AGENTS.md` を参照してください。CI は [Takumi Guard](https://shisho.dev/docs/ja/t/guard/quickstart/npm/) 経由でインストールし、リリースはワークフローが npm にステージして、メンテナーが 2FA で承認します。

## ライセンス

[MIT](LICENSE)
