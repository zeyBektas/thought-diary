import { Prisma } from '@prisma/client';

// The caller holds the exclusive organization row lock. This prevents new
// relationships in this scope while we lock the current rows in sharing order.
export async function revokeOrganizationGrants(
  tx: Prisma.TransactionClient,
  organizationId: string,
  memberUserId?: string,
) {
  const participation =
    memberUserId === undefined
      ? Prisma.empty
      : Prisma.sql`AND ("clientId" = ${memberUserId} OR "counselorId" = ${memberUserId})`;
  await tx.$queryRaw`
    SELECT id FROM care_relationships
    WHERE "organizationId" = ${organizationId} ${participation}
    ORDER BY id COLLATE "C" FOR UPDATE
  `;

  const scope: Prisma.CareRelationshipWhereInput = { organizationId };
  let revokedRelationshipCount = 0;
  if (memberUserId !== undefined) {
    scope.OR = [{ clientId: memberUserId }, { counselorId: memberUserId }];
    const result = await tx.careRelationship.updateMany({
      where: { ...scope, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED', endedAt: new Date() },
    });
    revokedRelationshipCount = result.count;
  }

  // The version includes the grant IDs. Removing grants invalidates stale
  // versions without acquiring journal locks after relationship locks.
  const { count: revokedGrantCount } = await tx.journalShare.deleteMany({
    where: { relationship: scope },
  });
  return { revokedRelationshipCount, revokedGrantCount };
}
