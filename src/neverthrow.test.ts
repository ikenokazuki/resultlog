import { describe, expect, test } from "bun:test";
import * as neverthrow from "neverthrow";
import { captureLogs, callableRequest } from "./testing.js";
import * as resultlog from "./index.js";

// resultlog brings neverthrow with it and re-exports it, so that one install and one import are all a project needs
// (with pnpm, a package that is not in your own package.json cannot be imported at all). The re-exports have to be
// neverthrow's own functions and classes: a copy would make `instanceof` and the types of two Results disagree.
describe("neverthrow comes with resultlog", () => {
  test.each([
    "Err",
    "Ok",
    "Result",
    "ResultAsync",
    "err",
    "errAsync",
    "fromAsyncThrowable",
    "fromPromise",
    "fromSafePromise",
    "fromThrowable",
    "ok",
    "okAsync",
    "safeTry",
  ] as const)("%s is neverthrow's own", (name) => {
    expect(resultlog[name]).toBeDefined();
    expect(resultlog[name]).toBe(neverthrow[name]);
  });

  test("a handler can be written with resultlog's imports alone", async () => {
    const logs = captureLogs();
    try {
      const { ok, okAsync, err, wrapCall, ResultAsync } = resultlog;
      const lookup = (id: string) => ResultAsync.fromPromise(Promise.resolve(id), (cause) => new resultlog.AppError("lookup failed", { code: "internal", cause }));
      const call = wrapCall((request) => lookup(String((request.data as { id?: string }).id)).andThen((id) => (id === "none" ? err(new resultlog.AppError("missing", { code: "not-found" })) : ok({ id }))));
      expect(await call(callableRequest({ id: "o1" }, { uid: "u1" }))).toEqual({ id: "o1" });
      await expect(call(callableRequest({ id: "none" }, { uid: "u1" }))).rejects.toMatchObject({ code: "not-found" });
      expect(logs.entries.map((e) => e.severity)).toEqual(["INFO", "WARNING"]);
      expect(await okAsync(1)).toEqual(ok(1));
    } finally {
      logs.restore();
    }
  });
});
