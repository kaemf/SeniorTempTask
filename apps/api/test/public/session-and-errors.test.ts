import { describe, expect, it } from "vitest";

import { parseDevSession } from "../../src/session.js";
import { stripErrorStack } from "../../src/trpc-error.js";

describe("parseDevSession", () => {
  it("builds an underwriter session from valid headers", () => {
    const session = parseDevSession({
      "x-user-id": "user-underwriter-1",
      "x-user-role": "UNDERWRITER",
    });

    expect(session).toEqual({
      user: { id: "user-underwriter-1", name: "Development User", role: "UNDERWRITER" },
    });
  });

  it("builds a support session from valid headers", () => {
    const session = parseDevSession({
      "x-user-id": "user-support-1",
      "x-user-role": "SUPPORT",
    });

    expect(session).toEqual({
      user: { id: "user-support-1", name: "Development User", role: "SUPPORT" },
    });
  });

  it("trims surrounding whitespace from the user id", () => {
    const session = parseDevSession({
      "x-user-id": "  user-underwriter-1  ",
      "x-user-role": "UNDERWRITER",
    });

    expect(session?.user.id).toBe("user-underwriter-1");
  });

  it("returns null when the id header is missing", () => {
    expect(parseDevSession({ "x-user-role": "UNDERWRITER" })).toBeNull();
  });

  it("returns null when the id header is empty", () => {
    expect(parseDevSession({ "x-user-id": "", "x-user-role": "UNDERWRITER" })).toBeNull();
  });

  it("returns null when the id header is only whitespace", () => {
    expect(parseDevSession({ "x-user-id": "   ", "x-user-role": "UNDERWRITER" })).toBeNull();
  });

  it("returns null when the role header is missing", () => {
    expect(parseDevSession({ "x-user-id": "user-underwriter-1" })).toBeNull();
  });

  it("returns null for a lowercase role", () => {
    expect(
      parseDevSession({ "x-user-id": "user-underwriter-1", "x-user-role": "underwriter" }),
    ).toBeNull();
  });

  it("returns null for an unknown role", () => {
    expect(
      parseDevSession({ "x-user-id": "user-underwriter-1", "x-user-role": "ADMIN" }),
    ).toBeNull();
  });

  it("returns null for an array id header", () => {
    expect(
      parseDevSession({
        "x-user-id": ["user-underwriter-1", "user-underwriter-2"],
        "x-user-role": "UNDERWRITER",
      }),
    ).toBeNull();
  });

  it("returns null for an array role header", () => {
    expect(
      parseDevSession({
        "x-user-id": "user-underwriter-1",
        "x-user-role": ["UNDERWRITER", "SUPPORT"],
      }),
    ).toBeNull();
  });
});

describe("stripErrorStack", () => {
  it("removes data.stack while preserving message, code, and other data fields", () => {
    const shape = {
      message: "Decision failed",
      code: -32603,
      data: {
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
        path: "loanApplications.decide",
        stack: "Error: Decision failed\n    at secret internal frame",
      },
    };

    const formatted = stripErrorStack(shape);

    expect(formatted).toEqual({
      message: "Decision failed",
      code: -32603,
      data: {
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
        path: "loanApplications.decide",
      },
    });
    expect("stack" in formatted.data).toBe(false);
  });

  it("leaves a shape without a stack unchanged", () => {
    const shape = {
      message: "Application not found",
      code: -32004,
      data: { code: "NOT_FOUND", httpStatus: 404 },
    };

    expect(stripErrorStack(shape)).toEqual(shape);
  });

  it("does not mutate the original shape", () => {
    const shape = {
      message: "Decision failed",
      code: -32603,
      data: { code: "INTERNAL_SERVER_ERROR", stack: "Error: boom" },
    };

    stripErrorStack(shape);

    expect(shape.data.stack).toBe("Error: boom");
  });
});
