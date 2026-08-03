import { RoleCode } from '../../src/common/enums/role-code.enum';
import { PrismaClient } from '@prisma/client';

export async function seedRoles(prisma: PrismaClient) {
  const roles = [RoleCode.ADMIN, RoleCode.CLIENT, RoleCode.COUNSELOR];

  for (const code of roles) {
    await prisma.role.upsert({
      where: { code },
      update: {},
      create: { code },
    });
  }

  console.log('Roles seeded');
}
