import type { LoanNotificationType, LoanNotifier } from "./notifier.js";

export type UserRole = "UNDERWRITER" | "SUPPORT";
export type LoanApplicationStatus =
  "PENDING_REVIEW" | "PENDING_CONFIRMATION" | "APPROVED" | "REJECTED";
export type DecisionCommand = "APPROVED" | "REJECTED" | "CONFIRMED";

/** Approvals above this amount (in minor units) require independent confirmation. */
export const CONFIRMATION_THRESHOLD_MINOR = 1_000_000;

/** Largest amount storable in the database's 32-bit integer column. */
export const MAX_AMOUNT_MINOR = 2_147_483_647;

export interface SessionUser {
  id: string;
  name: string;
  role: UserRole;
}

export interface LoanApplicationRecord {
  id: string;
  status: LoanApplicationStatus;
  requestedAmountMinor: number;
  approvedAmountMinor: number | null;
  proposedById: string | null;
  customer: {
    fullName: string;
    lastName: string;
    gender: string;
    taxId: string;
    email: string;
    phone: string;
    nationalId: string;
    monthlyIncomeMinor: number;
  };
}

export interface LoanApplicationView {
  id: string;
  status: LoanApplicationStatus;
  requestedAmountMinor: number;
  approvedAmountMinor: number | null;
  proposedById: string | null;
  customer: {
    fullName: string;
    lastName: string;
    gender: string;
    taxId: string;
    email: string;
  };
}

export interface DecideLoanApplicationInput {
  applicationId: string;
  decision: DecisionCommand;
  approvedAmountMinor?: number | undefined;
  reason: string;
}

export interface AuditRecordInput {
  applicationId: string;
  actorId: string;
  previousStatus: LoanApplicationStatus;
  newStatus: LoanApplicationStatus;
  approvedAmountMinor: number | null;
  reason: string;
}

export interface DecisionTransitionInput {
  decision: DecisionCommand;
  approvedAmountMinor?: number | undefined;
  reason: string;
}

export type DecisionTransition =
  | {
      ok: true;
      newStatus: LoanApplicationStatus;
      approvedAmountMinor: number | null;
      proposedById: string | null;
      expectedStatus: LoanApplicationStatus;
      notification: LoanNotificationType;
    }
  | {
      ok: false;
      code: "CONFLICT" | "BAD_REQUEST" | "FORBIDDEN";
      message: string;
    };

const TERMINAL_STATUSES: readonly LoanApplicationStatus[] = ["APPROVED", "REJECTED"];

/**
 * Pure decision-state machine: computes the transition a decision command causes,
 * or the reason it must be refused. Performs no I/O and never throws; persistence
 * and error transport live in the caller.
 */
export function decideTransition(
  application: LoanApplicationRecord,
  input: DecisionTransitionInput,
  actorId: string,
): DecisionTransition {
  if (TERMINAL_STATUSES.includes(application.status)) {
    return {
      ok: false,
      code: "CONFLICT",
      message: "Application already decided",
    };
  }

  if (input.decision === "REJECTED") {
    if (input.approvedAmountMinor !== undefined) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        message: "Rejection cannot have an amount",
      };
    }
    return {
      ok: true,
      newStatus: "REJECTED",
      approvedAmountMinor: null,
      proposedById: null,
      expectedStatus: application.status,
      notification: "REJECTED",
    };
  }

  if (input.decision === "APPROVED") {
    if (application.status !== "PENDING_REVIEW") {
      return {
        ok: false,
        code: "CONFLICT",
        message: "Only an application awaiting initial review may receive an initial approval",
      };
    }
    const amount = input.approvedAmountMinor;
    if (
      amount === undefined ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > MAX_AMOUNT_MINOR ||
      amount > application.requestedAmountMinor
    ) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        message: "Invalid approved amount",
      };
    }
    if (amount > CONFIRMATION_THRESHOLD_MINOR) {
      return {
        ok: true,
        newStatus: "PENDING_CONFIRMATION",
        approvedAmountMinor: amount,
        proposedById: actorId,
        expectedStatus: application.status,
        notification: "APPROVAL_PROPOSED",
      };
    }
    return {
      ok: true,
      newStatus: "APPROVED",
      approvedAmountMinor: amount,
      proposedById: null,
      expectedStatus: application.status,
      notification: "APPROVED",
    };
  }

  // input.decision === "CONFIRMED"
  if (application.status !== "PENDING_CONFIRMATION") {
    return {
      ok: false,
      code: "CONFLICT",
      message: "Only an application awaiting confirmation may be confirmed",
    };
  }
  if (input.approvedAmountMinor !== undefined) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      message: "Confirmation cannot have an amount",
    };
  }
  if (application.proposedById !== null && application.proposedById === actorId) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "The proposing underwriter cannot confirm their own approval",
    };
  }
  return {
    ok: true,
    newStatus: "APPROVED",
    approvedAmountMinor: application.approvedAmountMinor,
    proposedById: application.proposedById,
    expectedStatus: application.status,
    notification: "APPROVED",
  };
}

export interface ApplyDecisionParams {
  applicationId: string;
  expectedStatus: LoanApplicationStatus;
  newStatus: LoanApplicationStatus;
  approvedAmountMinor: number | null;
  proposedById: string | null;
  audit: AuditRecordInput;
}

export interface LoanRepository {
  findApplication(id: string): Promise<LoanApplicationRecord | null>;
  listApplications(): Promise<LoanApplicationRecord[]>;
  /**
   * Atomically applies a decision: the status update is conditional on
   * `expectedStatus` (optimistic lock) and the audit row is written in the same
   * transaction. Returns "CONFLICT" without writing anything when the
   * application is no longer in the expected state.
   */
  applyDecision(params: ApplyDecisionParams): Promise<LoanApplicationRecord | "CONFLICT">;
}

export interface AppLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface RequestContext {
  repository: LoanRepository;
  session: { user: SessionUser } | null;
  logger: AppLogger;
  notifier: LoanNotifier;
}
