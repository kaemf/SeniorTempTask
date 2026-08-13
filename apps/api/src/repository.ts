import type {
  LoanApplicationStatus as PrismaLoanApplicationStatus,
  PrismaClient,
} from "@loan-review/db";
import { Prisma } from "@loan-review/db";

import type {
  ApplyDecisionParams,
  LoanApplicationRecord,
  LoanApplicationStatus,
  LoanRepository,
} from "./domain.js";

function toRecord(application: {
  id: string;
  status: PrismaLoanApplicationStatus;
  requestedAmountMinor: number;
  approvedAmountMinor: number | null;
  proposedById: string | null;
  customerFullName: string;
  customerLastName: string;
  customerGender: string;
  customerTaxId: string;
  customerEmail: string;
  customerPhone: string;
  customerNationalId: string;
  monthlyIncomeMinor: number;
}): LoanApplicationRecord {
  return {
    id: application.id,
    status: application.status as LoanApplicationStatus,
    requestedAmountMinor: application.requestedAmountMinor,
    approvedAmountMinor: application.approvedAmountMinor,
    proposedById: application.proposedById,
    customer: {
      fullName: application.customerFullName,
      lastName: application.customerLastName,
      gender: application.customerGender,
      taxId: application.customerTaxId,
      email: application.customerEmail,
      phone: application.customerPhone,
      nationalId: application.customerNationalId,
      monthlyIncomeMinor: application.monthlyIncomeMinor,
    },
  };
}

export class PrismaLoanRepository implements LoanRepository {
  constructor(private readonly client: PrismaClient) {}

  async findApplication(id: string): Promise<LoanApplicationRecord | null> {
    const application = await this.client.loanApplication.findUnique({ where: { id } });
    return application ? toRecord(application) : null;
  }

  async listApplications(): Promise<LoanApplicationRecord[]> {
    const applications = await this.client.loanApplication.findMany({
      orderBy: { createdAt: "desc" },
    });
    return applications.map(toRecord);
  }

  async applyDecision(
    params: ApplyDecisionParams,
  ): Promise<LoanApplicationRecord | "CONFLICT" | "UNKNOWN_ACTOR"> {
    let result: LoanApplicationRecord | "CONFLICT";
    try {
      result = await this.runDecisionTransaction(params);
    } catch (error) {
      // A foreign-key violation (P2003) inside the transaction means the
      // session user does not exist in the User table: both user references
      // written here (the audit actorId and the proposer proposedById) come
      // from the acting session. The throw already aborted the transaction,
      // so the status update was rolled back and no audit row remains.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        return "UNKNOWN_ACTOR";
      }
      throw error;
    }
    return result;
  }

  private async runDecisionTransaction(
    params: ApplyDecisionParams,
  ): Promise<LoanApplicationRecord | "CONFLICT"> {
    const result = await this.client.$transaction(async (tx) => {
      // The conditional updateMany is the optimistic lock: it only matches while
      // the application is still in the state the decision was computed against.
      const updated = await tx.loanApplication.updateMany({
        where: {
          id: params.applicationId,
          status: params.expectedStatus as PrismaLoanApplicationStatus,
        },
        data: {
          status: params.newStatus as PrismaLoanApplicationStatus,
          approvedAmountMinor: params.approvedAmountMinor,
          proposedById: params.proposedById,
        },
      });

      if (updated.count === 0) {
        // Lost the race (or the state changed since it was read). Returning early
        // commits with no writes performed, so no audit row is created.
        return "CONFLICT" as const;
      }

      await tx.loanDecisionAudit.create({
        data: {
          applicationId: params.audit.applicationId,
          actorId: params.audit.actorId,
          previousStatus: params.audit.previousStatus as PrismaLoanApplicationStatus,
          newStatus: params.audit.newStatus as PrismaLoanApplicationStatus,
          approvedAmountMinor: params.audit.approvedAmountMinor,
          reason: params.audit.reason,
        },
      });

      return tx.loanApplication.findUniqueOrThrow({ where: { id: params.applicationId } });
    });

    return result === "CONFLICT" ? "CONFLICT" : toRecord(result);
  }
}
