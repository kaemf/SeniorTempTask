-- Tighten the proposer FK from SET NULL to RESTRICT. Deleting a user who has
-- an active proposed approval must fail loudly, not silently null out
-- proposedById: nulling it would void the self-confirmation ban and let the
-- original proposer confirm their own high-value approval. This mirrors the
-- RESTRICT already enforced on the audit actor FK.
ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_proposedById_fkey";
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "LoanApplication_proposedById_idx" ON "LoanApplication"("proposedById");
