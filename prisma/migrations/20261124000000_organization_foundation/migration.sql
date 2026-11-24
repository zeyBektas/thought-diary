-- Additive foundation only: no account, relationship, or share backfills.
ALTER TYPE "RoleCode" ADD VALUE 'PLATFORM_ADMIN';
CREATE TYPE "CounselorApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'LEFT', 'REMOVED');
CREATE TYPE "OrganizationPermission" AS ENUM ('MEMBER', 'ORG_ADMIN');
CREATE TYPE "InvitationType" AS ENUM ('CLIENT', 'COUNSELOR');
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');

ALTER TABLE "organizations" ADD COLUMN "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "suspendedAt" TIMESTAMP(3), ADD COLUMN "suspendedById" TEXT,
  ADD COLUMN "suspensionReason" TEXT, ADD COLUMN "reactivatedAt" TIMESTAMP(3);
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_suspendedById_fkey"
  FOREIGN KEY ("suspendedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "care_relationships" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "care_relationships" ADD CONSTRAINT "care_relationships_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "care_relationships_organizationId_idx" ON "care_relationships"("organizationId");

-- A NULL provenance means independent, and must never be changed in place.
CREATE FUNCTION "prevent_relationship_organization_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
    RAISE EXCEPTION 'Care relationship organization provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "care_relationships_organization_immutable"
  BEFORE UPDATE OF "organizationId" ON "care_relationships"
  FOR EACH ROW EXECUTE FUNCTION "prevent_relationship_organization_change"();

CREATE TABLE "user_roles" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "roleId" TEXT NOT NULL,
  "assignedById" TEXT, "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3), CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "user_roles_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_roles_active_user_role_key" ON "user_roles"("userId", "roleId") WHERE "revokedAt" IS NULL;
CREATE INDEX "user_roles_userId_idx" ON "user_roles"("userId");
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

CREATE TABLE "counselor_profiles" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "approvalStatus" "CounselorApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "professionalTitle" TEXT, "biography" TEXT, "approvedById" TEXT, "approvedAt" TIMESTAMP(3),
  "rejectedById" TEXT, "rejectedAt" TIMESTAMP(3), "rejectionReason" TEXT,
  "suspendedById" TEXT, "suspendedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "counselor_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "counselor_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "counselor_profiles_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "counselor_profiles_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "counselor_profiles_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "counselor_profiles_userId_key" ON "counselor_profiles"("userId");
CREATE INDEX "counselor_profiles_approvalStatus_idx" ON "counselor_profiles"("approvalStatus");

CREATE TABLE "organization_memberships" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE', "permission" "OrganizationPermission" NOT NULL DEFAULT 'MEMBER',
  "addedById" TEXT, "acceptedAt" TIMESTAMP(3), "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMP(3), "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "organization_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "organization_memberships_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "organization_memberships_current_pair_key" ON "organization_memberships"("organizationId", "userId") WHERE "status" IN ('ACTIVE', 'SUSPENDED');
CREATE INDEX "organization_memberships_userId_status_idx" ON "organization_memberships"("userId", "status");
CREATE INDEX "organization_memberships_organizationId_status_permission_idx" ON "organization_memberships"("organizationId", "status", "permission");

CREATE TABLE "organization_invitations" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "email" TEXT NOT NULL, "invitedUserId" TEXT,
  "type" "InvitationType" NOT NULL, "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "tokenHash" TEXT NOT NULL, "invitedById" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "organization_invitations_invitedUserId_fkey" FOREIGN KEY ("invitedUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "organization_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "organization_invitations_tokenHash_key" ON "organization_invitations"("tokenHash");
-- Expiration must be transitioned out of PENDING by future application logic.
CREATE UNIQUE INDEX "organization_invitations_pending_key" ON "organization_invitations"("organizationId", lower(btrim("email")), "type") WHERE "status" = 'PENDING';
CREATE INDEX "organization_invitations_organizationId_email_idx" ON "organization_invitations"("organizationId", "email");
CREATE INDEX "organization_invitations_expiresAt_idx" ON "organization_invitations"("expiresAt");

CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL, "actorUserId" TEXT NOT NULL, "organizationId" TEXT, "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL, "targetId" TEXT NOT NULL, "result" TEXT NOT NULL, "metadata" JSONB,
  "correlationId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");
CREATE INDEX "audit_logs_organizationId_createdAt_idx" ON "audit_logs"("organizationId", "createdAt");
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");
