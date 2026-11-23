-- Add explicit recipient grants without backfilling existing entries.
CREATE TABLE "journal_shares" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "journal_shares_journalId_relationshipId_key" ON "journal_shares"("journalId", "relationshipId");
CREATE INDEX "journal_shares_relationshipId_journalId_idx" ON "journal_shares"("relationshipId", "journalId");
ALTER TABLE "journal_shares" ADD CONSTRAINT "journal_shares_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_shares" ADD CONSTRAINT "journal_shares_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "care_relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
