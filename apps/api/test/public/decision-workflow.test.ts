import { describe, expect, it } from "vitest";

import { appRouter } from "../../src/router.js";
import {
  approvalInput,
  CapturingLogger,
  CapturingNotifier,
  createTestContext,
  InMemoryLoanRepository,
  secondUnderwriter,
  supportAgent,
  underwriter,
} from "../support/in-memory-repository.js";

const HIGH_VALUE = 1_500_000;

function highValueSetup() {
  const repository = new InMemoryLoanRepository();
  repository.application.requestedAmountMinor = 2_000_000;
  const notifier = new CapturingNotifier();
  const logger = new CapturingLogger();
  const adaCaller = appRouter.createCaller(
    createTestContext(repository, underwriter, logger, notifier),
  );
  const graceCaller = appRouter.createCaller(
    createTestContext(repository, secondUnderwriter, logger, notifier),
  );
  return { repository, notifier, logger, adaCaller, graceCaller };
}

describe("decide: authentication and authorization", () => {
  it("returns UNAUTHORIZED without a session", async () => {
    const caller = appRouter.createCaller(createTestContext(new InMemoryLoanRepository(), null));

    await expect(caller.loanApplications.decide(approvalInput())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns FORBIDDEN for a support agent", async () => {
    const caller = appRouter.createCaller(
      createTestContext(new InMemoryLoanRepository(), supportAgent),
    );

    await expect(caller.loanApplications.decide(approvalInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("decide: unknown session actor", () => {
  it("returns UNAUTHORIZED without state change, audits, or notifications", async () => {
    const repository = new InMemoryLoanRepository();
    repository.knownActorIds = new Set(["user-underwriter-2"]);
    const notifier = new CapturingNotifier();
    const caller = appRouter.createCaller(
      createTestContext(repository, underwriter, new CapturingLogger(), notifier),
    );

    await expect(caller.loanApplications.decide(approvalInput())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Session user is not recognized",
    });
    expect(repository.application.status).toBe("PENDING_REVIEW");
    expect(repository.application.approvedAmountMinor).toBeNull();
    expect(repository.audits).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
  });
});

describe("decide: lookup and state conflicts", () => {
  it("returns NOT_FOUND for an unknown application", async () => {
    const caller = appRouter.createCaller(createTestContext());

    await expect(
      caller.loanApplications.decide(approvalInput({ applicationId: "app-missing" })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("surfaces CONFLICT (not INTERNAL_SERVER_ERROR) when deciding an already-decided application", async () => {
    const repository = new InMemoryLoanRepository();
    repository.application.status = "APPROVED";
    repository.application.approvedAmountMinor = 400_000;
    const caller = appRouter.createCaller(createTestContext(repository));

    await expect(caller.loanApplications.decide(approvalInput())).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("allows exactly one of two concurrent decisions on the same pending application", async () => {
    const repository = new InMemoryLoanRepository();
    const notifier = new CapturingNotifier();
    const adaCaller = appRouter.createCaller(
      createTestContext(repository, underwriter, new CapturingLogger(), notifier),
    );
    const graceCaller = appRouter.createCaller(
      createTestContext(repository, secondUnderwriter, new CapturingLogger(), notifier),
    );

    const results = await Promise.allSettled([
      adaCaller.loanApplications.decide(approvalInput()),
      graceCaller.loanApplications.decide({
        applicationId: "app-pending",
        decision: "REJECTED",
        reason: "Income could not be verified",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(repository.audits).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });
});

describe("decide: approval workflow", () => {
  it("finalizes a low-value approval and notifies APPROVED", async () => {
    const repository = new InMemoryLoanRepository();
    const notifier = new CapturingNotifier();
    const caller = appRouter.createCaller(
      createTestContext(repository, underwriter, new CapturingLogger(), notifier),
    );

    const result = await caller.loanApplications.decide(approvalInput());

    expect(result).toEqual({
      applicationId: "app-pending",
      status: "APPROVED",
      approvedAmountMinor: 400_000,
    });
    expect(notifier.sent).toEqual([{ applicationId: "app-pending", type: "APPROVED" }]);
  });

  it("routes a high-value approval into PENDING_CONFIRMATION and notifies APPROVAL_PROPOSED", async () => {
    const { repository, notifier, adaCaller } = highValueSetup();

    const result = await adaCaller.loanApplications.decide(
      approvalInput({ approvedAmountMinor: HIGH_VALUE }),
    );

    expect(result).toEqual({
      applicationId: "app-pending",
      status: "PENDING_CONFIRMATION",
      approvedAmountMinor: HIGH_VALUE,
    });
    expect(repository.application.proposedById).toBe(underwriter.id);
    expect(notifier.sent).toEqual([{ applicationId: "app-pending", type: "APPROVAL_PROPOSED" }]);
    expect(repository.audits).toHaveLength(1);
    expect(repository.audits[0]).toMatchObject({
      applicationId: "app-pending",
      actorId: underwriter.id,
      previousStatus: "PENDING_REVIEW",
      newStatus: "PENDING_CONFIRMATION",
      approvedAmountMinor: HIGH_VALUE,
    });
  });

  it("lets a second underwriter confirm, preserving the proposed amount", async () => {
    const { repository, notifier, adaCaller, graceCaller } = highValueSetup();
    await adaCaller.loanApplications.decide(approvalInput({ approvedAmountMinor: HIGH_VALUE }));

    const result = await graceCaller.loanApplications.decide({
      applicationId: "app-pending",
      decision: "CONFIRMED",
      reason: "Independent review complete",
    });

    expect(result).toEqual({
      applicationId: "app-pending",
      status: "APPROVED",
      approvedAmountMinor: HIGH_VALUE,
    });
    expect(notifier.sent.map((notification) => notification.type)).toEqual([
      "APPROVAL_PROPOSED",
      "APPROVED",
    ]);
    expect(repository.audits).toHaveLength(2);
    expect(repository.audits[1]).toMatchObject({
      actorId: secondUnderwriter.id,
      previousStatus: "PENDING_CONFIRMATION",
      newStatus: "APPROVED",
      approvedAmountMinor: HIGH_VALUE,
    });
  });

  it("forbids the proposer from confirming their own approval", async () => {
    const { adaCaller } = highValueSetup();
    await adaCaller.loanApplications.decide(approvalInput({ approvedAmountMinor: HIGH_VALUE }));

    await expect(
      adaCaller.loanApplications.decide({
        applicationId: "app-pending",
        decision: "CONFIRMED",
        reason: "Trying to confirm my own proposal",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "The proposing underwriter cannot confirm their own approval",
    });
  });

  it("rejects from PENDING_CONFIRMATION, clearing the amount but preserving audit history", async () => {
    const { repository, notifier, adaCaller, graceCaller } = highValueSetup();
    await adaCaller.loanApplications.decide(approvalInput({ approvedAmountMinor: HIGH_VALUE }));

    const result = await graceCaller.loanApplications.decide({
      applicationId: "app-pending",
      decision: "REJECTED",
      reason: "Collateral valuation failed independent review",
    });

    expect(result).toEqual({
      applicationId: "app-pending",
      status: "REJECTED",
      approvedAmountMinor: null,
    });
    expect(repository.application.status).toBe("REJECTED");
    expect(repository.application.approvedAmountMinor).toBeNull();
    expect(repository.audits).toHaveLength(2);
    expect(repository.audits[0]).toMatchObject({
      newStatus: "PENDING_CONFIRMATION",
      approvedAmountMinor: HIGH_VALUE,
    });
    expect(repository.audits[1]).toMatchObject({
      actorId: secondUnderwriter.id,
      previousStatus: "PENDING_CONFIRMATION",
      newStatus: "REJECTED",
      approvedAmountMinor: null,
    });
    expect(notifier.sent.map((notification) => notification.type)).toEqual([
      "APPROVAL_PROPOSED",
      "REJECTED",
    ]);
  });
});

describe("decide: failure semantics", () => {
  it("fails the mutation without state change or audit row when the audit write fails", async () => {
    const repository = new InMemoryLoanRepository();
    repository.failNextAudit = true;
    const notifier = new CapturingNotifier();
    const caller = appRouter.createCaller(
      createTestContext(repository, underwriter, new CapturingLogger(), notifier),
    );

    await expect(caller.loanApplications.decide(approvalInput())).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(repository.application.status).toBe("PENDING_REVIEW");
    expect(repository.application.approvedAmountMinor).toBeNull();
    expect(repository.audits).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it("still succeeds when notification delivery fails", async () => {
    const repository = new InMemoryLoanRepository();
    const notifier = new CapturingNotifier();
    notifier.failNext = true;
    const logger = new CapturingLogger();
    const caller = appRouter.createCaller(
      createTestContext(repository, underwriter, logger, notifier),
    );

    const result = await caller.loanApplications.decide(approvalInput());

    expect(result.status).toBe("APPROVED");
    expect(repository.application.status).toBe("APPROVED");
    expect(repository.audits).toHaveLength(1);
    expect(logger.events.some((event) => event.level === "warn")).toBe(true);
  });
});
