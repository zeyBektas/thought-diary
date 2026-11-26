import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  type OrganizationPermission,
  type OrganizationStatus,
  Prisma,
} from '@prisma/client';

export const activeOrganizationMembership = {
  status: 'ACTIVE',
  acceptedAt: { not: null },
  user: { status: 'ACTIVE', deletedAt: null },
} satisfies Prisma.OrganizationMembershipWhereInput;

const activeOrganization = {
  status: 'ACTIVE',
  deletedAt: null,
} satisfies Prisma.OrganizationWhereInput;

type OrganizationState = {
  id: string;
  status: OrganizationStatus;
  deletedAt: Date | null;
};

export async function lockOrganization(
  tx: Prisma.TransactionClient,
  organizationId: string,
  mode: 'shared' | 'exclusive',
) {
  const lock =
    mode === 'shared' ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`;
  const [organization] = await tx.$queryRaw<OrganizationState[]>`
    SELECT id, status, "deletedAt" FROM organizations
    WHERE id = ${organizationId} AND "deletedAt" IS NULL ${lock}
  `;
  if (!organization) throw new NotFoundException('Organization not found');
  return organization;
}

export function requireActiveOrganization(organization: OrganizationState) {
  if (organization.status !== 'ACTIVE' || organization.deletedAt)
    throw new ForbiddenException('Organization is not active');
}

export async function requireActiveOrganizationMember(
  db: Pick<Prisma.TransactionClient, 'organizationMembership'>,
  organizationId: string,
  userId: string,
  permission?: OrganizationPermission,
) {
  const membership = await db.organizationMembership.findFirst({
    where: {
      ...activeOrganizationMembership,
      organizationId,
      userId,
      organization: activeOrganization,
      ...(permission && { permission }),
    },
    select: { id: true, permission: true },
  });
  if (!membership)
    throw new ForbiddenException('Active organization membership required');
  return membership;
}

// Relationship writers acquire the organization lock before profile or
// relationship locks. Lifecycle writers acquire the same lock exclusively.
export async function lockRelationshipOrganization(
  tx: Prisma.TransactionClient,
  organizationId: string | null,
  clientId: string,
  counselorId: string,
) {
  if (organizationId === null) return;
  const organization = await lockOrganization(tx, organizationId, 'shared');
  requireActiveOrganization(organization);
  const count = await tx.organizationMembership.count({
    where: {
      ...activeOrganizationMembership,
      organizationId,
      userId: { in: [clientId, counselorId] },
    },
  });
  if (count !== 2)
    throw new ForbiddenException(
      'Both participants need active memberships in this organization',
    );
}

// Prisma filters cannot compare a participant ID with a membership column on
// the related organization. Use the same correlated predicate for every read.
// Callers of this SQL fragment name the care_relationships alias "r".
export const operationalOrganizationRelationshipSql = Prisma.sql`(
  r."organizationId" IS NULL OR EXISTS (
    SELECT 1 FROM organizations org
    WHERE org.id = r."organizationId" AND org.status = 'ACTIVE'
      AND org."deletedAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM organization_memberships member
        JOIN users participant ON participant.id = member."userId"
        WHERE member."organizationId" = org.id
          AND member."userId" = r."clientId" AND member.status = 'ACTIVE'
          AND member."acceptedAt" IS NOT NULL
          AND participant.status = 'ACTIVE' AND participant."deletedAt" IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM organization_memberships member
        JOIN users participant ON participant.id = member."userId"
        WHERE member."organizationId" = org.id
          AND member."userId" = r."counselorId" AND member.status = 'ACTIVE'
          AND member."acceptedAt" IS NOT NULL
          AND participant.status = 'ACTIVE' AND participant."deletedAt" IS NULL
      )
  )
)`;

type RelationshipScope =
  | { participantId: string }
  | { clientId: string }
  | { relationshipIds: readonly string[]; clientId: string }
  | { journalId: string; clientId: string };

export async function eligibleOrganizationRelationshipIds(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  scope: RelationshipScope,
) {
  let condition: Prisma.Sql;
  if ('participantId' in scope) {
    const { participantId } = scope;
    condition = Prisma.sql`(r."clientId" = ${participantId} OR r."counselorId" = ${participantId})`;
  } else {
    condition = Prisma.sql`r."clientId" = ${scope.clientId}`;
    if ('relationshipIds' in scope) {
      if (!scope.relationshipIds.length) return [];
      condition = Prisma.sql`${condition} AND r.id IN (${Prisma.join(scope.relationshipIds)})`;
    } else if ('journalId' in scope) {
      condition = Prisma.sql`${condition} AND EXISTS (
        SELECT 1 FROM journal_shares js
        WHERE js."relationshipId" = r.id AND js."journalId" = ${scope.journalId}
      )`;
    }
  }
  const relationships = await db.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM care_relationships r
    WHERE r."organizationId" IS NOT NULL AND r."deletedAt" IS NULL
      AND ${condition} AND ${operationalOrganizationRelationshipSql}
  `;
  return relationships.map(({ id }) => id);
}
