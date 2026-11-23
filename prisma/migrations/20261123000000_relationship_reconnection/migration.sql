-- Preserve uniqueness throughout the change. REJECTED and soft-deleted
-- non-revoked relationships continue to block another request.
BEGIN;
CREATE UNIQUE INDEX "care_relationships_non_revoked_pair_key"
  ON "care_relationships" ("counselorId", "clientId")
  WHERE "status" <> 'REVOKED';
DROP INDEX "care_relationships_counselorId_clientId_key";
COMMIT;

-- Reversal requires resolving duplicate pairs, including revoked history,
-- before recreating the original unconditional unique index.
