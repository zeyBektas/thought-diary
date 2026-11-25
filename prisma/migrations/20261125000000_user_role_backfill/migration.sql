-- Deploy with legacy user-creation writers stopped until all writers create
-- UserRole assignments; a one-time backfill cannot cover later legacy writes.
BEGIN;
-- Legacy User.roleId records contain no assignment timestamp or actor.
ALTER TABLE "user_roles" ALTER COLUMN "assignedAt" DROP NOT NULL;

-- BEGIN ROLE BACKFILL
-- Do not recreate a revoked assignment on a rerun. In particular, never infer
-- PLATFORM_ADMIN from legacy ADMIN (or any other legacy assignment).
INSERT INTO "user_roles" ("id", "userId", "roleId", "assignedById", "assignedAt", "revokedAt")
SELECT gen_random_uuid()::text, u.id, r.id, NULL, NULL, NULL
FROM "users" u
JOIN "roles" r ON r.id = u."roleId"
WHERE r.code IN ('CLIENT', 'COUNSELOR', 'ADMIN')
  AND NOT EXISTS (
    SELECT 1 FROM "user_roles" existing
    WHERE existing."userId" = u.id AND existing."roleId" = r.id
  )
ON CONFLICT ("userId", "roleId") WHERE "revokedAt" IS NULL DO NOTHING;
-- END ROLE BACKFILL
COMMIT;
