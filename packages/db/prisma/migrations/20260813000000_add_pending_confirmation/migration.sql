-- Add the new workflow status. Existing rows are not touched: legacy
-- PENDING_REVIEW / APPROVED / REJECTED rows keep their status, so final
-- decisions are never reinterpreted as pending confirmation.
ALTER TYPE "LoanApplicationStatus" ADD VALUE 'PENDING_CONFIRMATION';

-- Track which underwriter proposed a high-value approval. Nullable, no
-- backfill: legacy rows simply have no proposer recorded.
ALTER TABLE "LoanApplication" ADD COLUMN "proposedById" TEXT;

ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_proposedById_fkey"
  FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
