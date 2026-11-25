import type { Prisma } from '@prisma/client';

// The caller holds the counselor profile lock, which serializes relationship
// writers. Lock relationships in the same order as diary sharing before
// deleting grants. The removed grant IDs change each affected shareVersion.
export async function revokeCounselorGrants(
  tx: Prisma.TransactionClient,
  counselorId: string,
): Promise<number> {
  await tx.$queryRaw`
    SELECT id FROM care_relationships WHERE "counselorId" = ${counselorId}
    ORDER BY id COLLATE "C" FOR UPDATE
  `;
  const result = await tx.journalShare.deleteMany({
    where: { relationship: { counselorId } },
  });
  return result.count;
}
