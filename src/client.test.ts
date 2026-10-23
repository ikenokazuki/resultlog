import { describe, expect, test } from "bun:test";
import { parseError, parseErrorBody } from "./client.js";

// What the Firebase JS SDK throws for a callable that failed: code carries a "functions/" prefix.
const firebaseError = (code: string, message: string, details?: unknown) => Object.assign(new Error(message), { code: `functions/${code}`, details });

describe("parseError", () => {
  test("strips the functions/ prefix and reads the reason resultlog sends", () => {
    const error = parseError(firebaseError("already-exists", "ALREADY_EXISTS", { reason: "EmailTaken", field: "email" }));
    expect(error).toMatchObject({ code: "already-exists", reason: "EmailTaken", message: "ALREADY_EXISTS", details: { field: "email" }, retryable: false });
  });

  test("turns zod issues into messages per field, for a form", () => {
    const issues = [
      { code: "invalid_type", path: ["email"], message: "Invalid input: expected string, received undefined" },
      { code: "too_small", path: ["address", "zip"], message: "Too small" },
      { code: "custom", path: ["address", "zip"], message: "Not a postcode" },
      { code: "custom", path: [], message: "Passwords differ" },
      { code: "invalid_type", path: ["items", 2, "qty"], message: "Expected number" },
    ];
    const error = parseError(firebaseError("invalid-argument", "INVALID_ARGUMENT", { reason: "InvalidInput", issues }));
    expect(error.reason).toBe("InvalidInput");
    expect(error.issues).toHaveLength(5);
    expect(error.fieldErrors).toEqual({
      email: ["Invalid input: expected string, received undefined"],
      "address.zip": ["Too small", "Not a postcode"],
      _form: ["Passwords differ"],
      "items.2.qty": ["Expected number"],
    });
  });

  test("says which failures are worth trying again", () => {
    for (const code of ["unavailable", "deadline-exceeded", "resource-exhausted", "aborted"]) {
      expect(parseError(firebaseError(code, code.toUpperCase())).retryable).toBe(true);
    }
    for (const code of ["invalid-argument", "not-found", "permission-denied", "internal", "unauthenticated"]) {
      expect(parseError(firebaseError(code, code.toUpperCase())).retryable).toBe(false);
    }
  });

  test("copes with an error that has no details, and with values that are not errors at all", () => {
    expect(parseError(firebaseError("internal", "INTERNAL"))).toMatchObject({ code: "internal", details: {}, issues: [], fieldErrors: {} });
    expect(parseError(new Error("network down"))).toMatchObject({ code: "unknown", message: "network down", retryable: false });
    expect(parseError("oops")).toMatchObject({ code: "unknown", message: "oops" });
    expect(parseError(undefined)).toMatchObject({ code: "unknown" });
  });

  test("ignores details that are not an object", () => {
    expect(parseError(firebaseError("not-found", "NOT_FOUND", "just text")).details).toEqual({});
  });
});

describe("parseErrorBody", () => {
  test("reads the JSON that wrapRequest sends", () => {
    const body = { error: { status: "FAILED_PRECONDITION", message: "Card declined.", details: { reason: "CardDeclined" } } };
    expect(parseErrorBody(body)).toMatchObject({ code: "failed-precondition", reason: "CardDeclined", message: "Card declined.", retryable: false });
  });

  test("handles zod issues and retryable statuses the same way", () => {
    const body = { error: { status: "UNAVAILABLE", message: "UNAVAILABLE" } };
    expect(parseErrorBody(body).retryable).toBe(true);
    const invalid = { error: { status: "INVALID_ARGUMENT", message: "x", details: { issues: [{ path: ["id"], message: "Required" }] } } };
    expect(parseErrorBody(invalid).fieldErrors).toEqual({ id: ["Required"] });
  });

  test("a body that is not an error is reported as unknown", () => {
    expect(parseErrorBody({ result: 1 })).toMatchObject({ code: "unknown" });
    expect(parseErrorBody(null)).toMatchObject({ code: "unknown" });
  });
});
