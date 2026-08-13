import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_THRESHOLD_MINOR,
  decideTransition,
  MAX_AMOUNT_MINOR,
  type LoanApplicationRecord,
  type LoanApplicationStatus,
} from "../../src/domain.js";

const ADA = "user-underwriter-1";
const GRACE = "user-underwriter-2";

function application(
  overrides: Partial<
    Pick<
      LoanApplicationRecord,
      "status" | "requestedAmountMinor" | "approvedAmountMinor" | "proposedById"
    >
  > = {},
): LoanApplicationRecord {
  return {
    id: "app-1",
    status: "PENDING_REVIEW",
    requestedAmountMinor: 2_000_000,
    approvedAmountMinor: null,
    proposedById: null,
    customer: {
      fullName: "Olena Kovalenko",
      lastName: "Kovalenko",
      gender: "FEMALE",
      taxId: "TAX-72419831",
      email: "olena@example.test",
      phone: "+380501234567",
      nationalId: "ID-72419831",
      monthlyIncomeMinor: 180_000,
    },
    ...overrides,
  };
}

const reason = "Documented reason";

describe("decideTransition: initial approval", () => {
  it("finalizes an approval at exactly the confirmation threshold", () => {
    const result = decideTransition(
      application(),
      { decision: "APPROVED", approvedAmountMinor: CONFIRMATION_THRESHOLD_MINOR, reason },
      ADA,
    );

    expect(result).toEqual({
      ok: true,
      newStatus: "APPROVED",
      approvedAmountMinor: 1_000_000,
      proposedById: null,
      expectedStatus: "PENDING_REVIEW",
      notification: "APPROVED",
    });
  });

  it("routes an approval one unit above the threshold into confirmation", () => {
    const result = decideTransition(
      application(),
      { decision: "APPROVED", approvedAmountMinor: CONFIRMATION_THRESHOLD_MINOR + 1, reason },
      ADA,
    );

    expect(result).toEqual({
      ok: true,
      newStatus: "PENDING_CONFIRMATION",
      approvedAmountMinor: 1_000_001,
      proposedById: ADA,
      expectedStatus: "PENDING_REVIEW",
      notification: "APPROVAL_PROPOSED",
    });
  });

  it("finalizes a low-value approval immediately", () => {
    const result = decideTransition(
      application(),
      { decision: "APPROVED", approvedAmountMinor: 400_000, reason },
      ADA,
    );

    expect(result).toMatchObject({ ok: true, newStatus: "APPROVED", notification: "APPROVED" });
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -5],
    ["fractional", 1000.5],
    ["above the requested amount", 2_000_001],
    ["above the int32 maximum", MAX_AMOUNT_MINOR + 1],
  ])("rejects an approval amount that is %s", (_label, amount) => {
    const result = decideTransition(
      application(),
      { decision: "APPROVED", approvedAmountMinor: amount, reason },
      ADA,
    );

    expect(result).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });

  it("rejects an over-int32 amount even when the requested amount would allow it", () => {
    const result = decideTransition(
      application({ requestedAmountMinor: MAX_AMOUNT_MINOR }),
      { decision: "APPROVED", approvedAmountMinor: MAX_AMOUNT_MINOR + 1, reason },
      ADA,
    );

    expect(result).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });

  it("refuses an initial approval on an application awaiting confirmation", () => {
    const result = decideTransition(
      application({
        status: "PENDING_CONFIRMATION",
        approvedAmountMinor: 1_500_000,
        proposedById: ADA,
      }),
      { decision: "APPROVED", approvedAmountMinor: 1_500_000, reason },
      GRACE,
    );

    expect(result).toMatchObject({ ok: false, code: "CONFLICT" });
  });
});

describe("decideTransition: confirmation", () => {
  const pendingConfirmation = () =>
    application({
      status: "PENDING_CONFIRMATION",
      approvedAmountMinor: 1_500_000,
      proposedById: ADA,
    });

  it("lets a different underwriter confirm, preserving the proposed amount", () => {
    const result = decideTransition(
      pendingConfirmation(),
      { decision: "CONFIRMED", reason },
      GRACE,
    );

    expect(result).toEqual({
      ok: true,
      newStatus: "APPROVED",
      approvedAmountMinor: 1_500_000,
      proposedById: ADA,
      expectedStatus: "PENDING_CONFIRMATION",
      notification: "APPROVED",
    });
  });

  it("forbids the proposing underwriter from confirming their own approval", () => {
    const result = decideTransition(pendingConfirmation(), { decision: "CONFIRMED", reason }, ADA);

    expect(result).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "The proposing underwriter cannot confirm their own approval",
    });
  });

  it("refuses a confirmation that carries an amount", () => {
    const result = decideTransition(
      pendingConfirmation(),
      { decision: "CONFIRMED", approvedAmountMinor: 1_500_000, reason },
      GRACE,
    );

    expect(result).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });

  it("refuses to confirm an application still awaiting initial review", () => {
    const result = decideTransition(application(), { decision: "CONFIRMED", reason }, GRACE);

    expect(result).toMatchObject({ ok: false, code: "CONFLICT" });
  });
});

describe("decideTransition: rejection", () => {
  it("rejects from PENDING_REVIEW and clears the amount", () => {
    const result = decideTransition(application(), { decision: "REJECTED", reason }, ADA);

    expect(result).toEqual({
      ok: true,
      newStatus: "REJECTED",
      approvedAmountMinor: null,
      proposedById: null,
      expectedStatus: "PENDING_REVIEW",
      notification: "REJECTED",
    });
  });

  it("lets the original proposer reject from PENDING_CONFIRMATION, clearing the amount", () => {
    const result = decideTransition(
      application({
        status: "PENDING_CONFIRMATION",
        approvedAmountMinor: 1_500_000,
        proposedById: ADA,
      }),
      { decision: "REJECTED", reason },
      ADA,
    );

    expect(result).toEqual({
      ok: true,
      newStatus: "REJECTED",
      approvedAmountMinor: null,
      proposedById: null,
      expectedStatus: "PENDING_CONFIRMATION",
      notification: "REJECTED",
    });
  });

  it("refuses a rejection that carries an amount", () => {
    const result = decideTransition(
      application(),
      { decision: "REJECTED", approvedAmountMinor: 100, reason },
      ADA,
    );

    expect(result).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });
});

describe("decideTransition: terminal states", () => {
  const decisions = ["APPROVED", "REJECTED", "CONFIRMED"] as const;
  const terminal: LoanApplicationStatus[] = ["APPROVED", "REJECTED"];

  it.each(terminal.flatMap((status) => decisions.map((decision) => [status, decision] as const)))(
    "refuses %s applications for decision %s",
    (status, decision) => {
      const result = decideTransition(
        application({ status, approvedAmountMinor: status === "APPROVED" ? 400_000 : null }),
        { decision, approvedAmountMinor: decision === "APPROVED" ? 100 : undefined, reason },
        ADA,
      );

      expect(result).toMatchObject({ ok: false, code: "CONFLICT" });
    },
  );
});
