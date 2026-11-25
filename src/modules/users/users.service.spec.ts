import { Test, TestingModule } from '@nestjs/testing';
import { hasCurrentRole, UsersService } from './users.service';
import { PrismaService } from '@/core/prisma/prisma.service';
import { RoleCode } from '@prisma/client';

describe('UsersService', () => {
  let service: UsersService;
  const prisma = { user: { findUnique: jest.fn(), create: jest.fn() } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('resolves current assignments and never promotes legacy ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user',
      email: 'user@example.test',
      username: null,
      firstName: 'A',
      lastName: 'B',
      phone: null,
      status: 'ACTIVE',
      deletedAt: null,
      roleId: 'admin',
      role: { code: RoleCode.ADMIN },
      roleAssignments: [
        { roleId: 'admin', role: { code: RoleCode.ADMIN } },
        { roleId: 'client', role: { code: RoleCode.CLIENT } },
      ],
    });
    const user = await service.resolveCurrentUser('user');
    expect(user.roles).toEqual([RoleCode.ADMIN, RoleCode.CLIENT]);
    expect(user.role).toBe(RoleCode.ADMIN);
    expect(hasCurrentRole(user, RoleCode.PLATFORM_ADMIN)).toBe(false);
    expect(hasCurrentRole(user, RoleCode.CLIENT)).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          roleAssignments: {
            where: { revokedAt: null, role: { deletedAt: null } },
            select: { role: { select: { code: true } } },
          },
        }) as unknown,
      }),
    );
  });

  it('preserves the legacy compatibility role after revocation without authorizing it', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user',
      email: 'user@example.test',
      username: null,
      firstName: 'A',
      lastName: 'B',
      phone: null,
      status: 'ACTIVE',
      deletedAt: null,
      roleId: 'client',
      role: { code: RoleCode.CLIENT },
      roleAssignments: [
        { roleId: 'counselor', role: { code: RoleCode.COUNSELOR } },
      ],
    });
    const user = await service.resolveCurrentUser('user');
    expect(user.role).toBe(RoleCode.CLIENT);
    expect(hasCurrentRole(user, RoleCode.CLIENT)).toBe(false);
    expect(hasCurrentRole(user, RoleCode.COUNSELOR)).toBe(true);
  });

  it.each([
    null,
    { status: 'INACTIVE' },
    { status: 'SUSPENDED' },
    { status: 'ACTIVE', deletedAt: new Date() },
  ])('rejects missing or ineligible accounts: %s', async (account) => {
    prisma.user.findUnique.mockResolvedValue(account);
    await expect(service.resolveCurrentUser('user')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('creates the initial role assignment atomically with the user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'user' });
    await service.create({
      email: 'user@example.test',
      passwordHash: 'hash',
      firstName: 'A',
      lastName: 'B',
      roleId: 'client',
    });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          roleId: 'client',
          roleAssignments: { create: { roleId: 'client' } },
        }) as unknown,
      }),
    );
  });
});
