import type {
  AppLogger,
  ApplyDecisionParams,
  AuditRecordInput,
  LoanApplicationRecord,
  LoanRepository,
  RequestContext,
  SessionUser,
} from "../../src/domain.js";
import type { LoanNotification, LoanNotifier } from "../../src/notifier.js";

const seededApplication: LoanApplicationRecord = {
  id: "app-pending",
  status: "PENDING_REVIEW",
  requestedAmountMinor: 500_000,
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
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryLoanRepository implements LoanRepository {
  application = clone(seededApplication);
  audits: AuditRecordInput[] = [];
  failNextAudit = false;
  /**
   * When non-null, mirrors the database's actor foreign key: a decision by an
   * actor outside this set fails as "UNKNOWN_ACTOR" with every write rolled
   * back. Null (the default) means every actor is known.
   */
  knownActorIds: Set<string> | null = null;

  async findApplication(id: string): Promise<LoanApplicationRecord | null> {
    return id === this.application.id ? clone(this.application) : null;
  }

  async listApplications(): Promise<LoanApplicationRecord[]> {
    return [clone(this.application)];
  }

  // Deliberately synchronous from the expectedStatus check through the audit
  // write: no awaits, so interleaved calls cannot observe a half-applied
  // decision. This mirrors the transactional conditional update in the real
  // Prisma repository and makes concurrency tests meaningful.
  async applyDecision(
    params: ApplyDecisionParams,
  ): Promise<LoanApplicationRecord | "CONFLICT" | "UNKNOWN_ACTOR"> {
    if (params.applicationId !== this.application.id) {
      return "CONFLICT";
    }
    if (this.application.status !== params.expectedStatus) {
      return "CONFLICT";
    }
    if (this.knownActorIds !== null && !this.knownActorIds.has(params.audit.actorId)) {
      // Mirrors the rolled-back FK violation: no state change, no audit row.
      return "UNKNOWN_ACTOR";
    }
    if (this.failNextAudit) {
      // Atomicity: a failing audit write aborts the whole decision, leaving
      // the application unchanged and no audit row behind.
      this.failNextAudit = false;
      throw new Error("Injected audit failure");
    }
    this.application.status = params.newStatus;
    this.application.approvedAmountMinor = params.approvedAmountMinor;
    this.application.proposedById = params.proposedById;
    this.audits.push(clone(params.audit));
    return clone(this.application);
  }
}

export class CapturingLogger implements AppLogger {
  events: Array<{
    level: "info" | "warn" | "error";
    context: Record<string, unknown>;
    message: string;
  }> = [];

  info(context: Record<string, unknown>, message: string): void {
    this.events.push({ level: "info", context: clone(context), message });
  }

  warn(context: Record<string, unknown>, message: string): void {
    this.events.push({ level: "warn", context: clone(context), message });
  }

  error(context: Record<string, unknown>, message: string): void {
    this.events.push({ level: "error", context: clone(context), message });
  }
}

export class CapturingNotifier implements LoanNotifier {
  sent: LoanNotification[] = [];
  failNext = false;

  async send(notification: LoanNotification): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Injected notifier failure");
    }
    this.sent.push(clone(notification));
  }
}

export const underwriter: SessionUser = {
  id: "user-underwriter-1",
  name: "Ada Underwriter",
  role: "UNDERWRITER",
};

export const secondUnderwriter: SessionUser = {
  id: "user-underwriter-2",
  name: "Grace Underwriter",
  role: "UNDERWRITER",
};

export const supportAgent: SessionUser = {
  id: "user-support-1",
  name: "Sam Support",
  role: "SUPPORT",
};

export function createTestContext(
  repository = new InMemoryLoanRepository(),
  user: SessionUser | null = underwriter,
  logger = new CapturingLogger(),
  notifier = new CapturingNotifier(),
): RequestContext {
  return { repository, session: user ? { user } : null, logger, notifier };
}

export function approvalInput(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: "app-pending",
    decision: "APPROVED" as const,
    approvedAmountMinor: 400_000,
    reason: "Affordability checks passed",
    ...overrides,
  };
}
