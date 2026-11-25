import { ForbiddenException } from '@nestjs/common';
import { CounselorApprovalStatus, Prisma, RoleCode } from '@prisma/client';

export const counselorEligibility = {
  status: 'ACTIVE',
  deletedAt: null,
  roleAssignments: {
    some: {
      revokedAt: null,
      role: { code: RoleCode.COUNSELOR, deletedAt: null },
    },
  },
  counselorProfile: { approvalStatus: CounselorApprovalStatus.APPROVED },
} satisfies Prisma.UserWhereInput;

// The diary queries need eligibility and journal access in one SQL snapshot.
export function counselorEligibilitySql(userId: string) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM users counselor
    JOIN counselor_profiles profile ON profile."userId" = counselor.id
    WHERE counselor.id = ${userId}
      AND counselor.status = 'ACTIVE' AND counselor."deletedAt" IS NULL
      AND profile."approvalStatus" = 'APPROVED'
      AND EXISTS (
        SELECT 1 FROM user_roles counselor_assignment
        JOIN roles counselor_role ON counselor_role.id = counselor_assignment."roleId"
        WHERE counselor_assignment."userId" = counselor.id
          AND counselor_assignment."revokedAt" IS NULL
          AND counselor_role.code = 'COUNSELOR' AND counselor_role."deletedAt" IS NULL
      )
  )`;
}

export async function requireEligibleCounselor(
  db: Pick<Prisma.TransactionClient, 'user'>,
  userId: string,
) {
  const counselor = await db.user.findFirst({
    where: { id: userId, ...counselorEligibility },
    select: { id: true },
  });
  if (!counselor)
    throw new ForbiddenException('Only approved counselors can do this');
}

// Relationship writers must finish before a suspension scans or changes grants.
export async function lockEligibleCounselor(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const profiles = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM counselor_profiles WHERE "userId" = ${userId} FOR SHARE
  `;
  if (!profiles.length)
    throw new ForbiddenException('Only approved counselors can do this');
  await requireEligibleCounselor(tx, userId);
}
