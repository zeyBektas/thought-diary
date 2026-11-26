-- Keep the existing uniqueness guarantee until both context indexes are in place.
-- Preserve all relationship rows, including NULL (independent) provenance.
BEGIN;
CREATE UNIQUE INDEX "care_relationships_non_revoked_independent_pair_key"
  ON "care_relationships" ("counselorId", "clientId")
  WHERE "organizationId" IS NULL AND "status" <> 'REVOKED';
CREATE UNIQUE INDEX "care_relationships_non_revoked_organization_pair_key"
  ON "care_relationships" ("counselorId", "clientId", "organizationId")
  WHERE "organizationId" IS NOT NULL AND "status" <> 'REVOKED';
DROP INDEX "care_relationships_non_revoked_pair_key";
COMMIT;
