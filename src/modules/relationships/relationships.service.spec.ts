import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CareRelationshipStatus as Status,
  Prisma,
  RoleCode,
} from '@prisma/client';
import { PrismaService } from '@/core/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { RelationshipsService } from './relationships.service';

describe('RelationshipsService', () => {
  const db = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  };
  const users = { findById: jest.fn() };
  const shares = { deleteMany: jest.fn() };
  const service = new RelationshipsService(
    {
      careRelationship: db,
      $transaction: (callback: (tx: unknown) => unknown) =>
        callback({ careRelationship: db, journalShare: shares }),
    } as unknown as PrismaService,
    users as unknown as UsersService,
  );
  const assignment = (
    code: RoleCode,
    revokedAt: Date | null = null,
    deletedAt: Date | null = null,
  ) => ({
    revokedAt,
    role: { code, deletedAt },
  });
  const person = (code: RoleCode, overrides: Record<string, unknown> = {}) => ({
    status: 'ACTIVE',
    deletedAt: null,
    role: { code, deletedAt: null },
    roleAssignments: [assignment(code)],
    ...overrides,
  });
  const relationship = (status: Status = Status.PENDING) => ({
    id: 'rel',
    counselorId: 'counselor',
    clientId: 'client',
    status,
    deletedAt: null,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    users.findById.mockImplementation((id: string) =>
      Promise.resolve(
        person(id === 'counselor' ? RoleCode.COUNSELOR : RoleCode.CLIENT),
      ),
    );
    db.findFirst.mockResolvedValue(relationship());
    db.updateMany.mockResolvedValue({ count: 1 });
  });

  it('lets an active counselor request a client', async () => {
    db.findFirst.mockResolvedValue(null);
    db.create.mockResolvedValue(relationship());
    await expect(
      service.request('counselor', { clientId: 'client' }),
    ).resolves.toEqual(relationship());
    expect(db.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          counselorId: 'counselor',
          clientId: 'client',
          status: Status.PENDING,
        },
      }),
    );
    expect(db.findFirst).toHaveBeenCalledWith({
      where: {
        counselorId: 'counselor',
        clientId: 'client',
        status: { not: Status.REVOKED },
      },
    });
  });

  it('lists only active relationships and active counselors with active counselor roles', async () => {
    const counselor = {
      id: 'counselor',
      firstName: 'Synthetic',
      lastName: 'Counselor',
      username: null,
    };
    db.findMany.mockResolvedValue([{ id: 'rel', counselor }]);
    await expect(
      service.shareableCounselors({
        userId: 'client',
        roles: [RoleCode.CLIENT],
      }),
    ).resolves.toEqual({
      counselors: [{ relationshipId: 'rel', counselor }],
    });
    expect(users.findById).not.toHaveBeenCalled();
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId: 'client',
          status: Status.ACTIVE,
          deletedAt: null,
          counselor: {
            status: 'ACTIVE',
            deletedAt: null,
            roleAssignments: {
              some: {
                revokedAt: null,
                role: { code: RoleCode.COUNSELOR, deletedAt: null },
              },
            },
          },
        },
        select: {
          id: true,
          counselor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
            },
          },
        },
      }),
    );
  });

  it('returns an empty list when the client has no shareable counselors', async () => {
    db.findMany.mockResolvedValue([]);
    await expect(
      service.shareableCounselors({
        userId: 'client',
        roles: [RoleCode.CLIENT],
      }),
    ).resolves.toEqual({ counselors: [] });
  });

  it.each([
    { label: 'counselor only', roles: [RoleCode.COUNSELOR] },
    { label: 'legacy administrator', roles: [RoleCode.ADMIN] },
    { label: 'no active roles', roles: [] },
  ])(
    'does not list shareable counselors for $label despite a legacy client role',
    async ({ roles }) => {
      const user = { userId: 'client', roles, role: RoleCode.CLIENT };
      await expect(service.shareableCounselors(user)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(users.findById).not.toHaveBeenCalled();
      expect(db.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['non-counselor', person(RoleCode.CLIENT)],
    ['inactive', person(RoleCode.COUNSELOR, { status: 'INACTIVE' })],
    ['deleted', person(RoleCode.COUNSELOR, { deletedAt: new Date() })],
  ])('rejects a %s counselor', async (_label, user) => {
    users.findById.mockResolvedValue(user);
    await expect(
      service.request('counselor', { clientId: 'client' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.create).not.toHaveBeenCalled();
  });

  it.each([
    ['missing client', null, NotFoundException],
    ['non-client target', person(RoleCode.COUNSELOR), BadRequestException],
  ])('rejects a %s', async (_label, target, error) => {
    users.findById
      .mockResolvedValueOnce(person(RoleCode.COUNSELOR))
      .mockResolvedValueOnce(target);
    await expect(
      service.request('counselor', { clientId: 'client' }),
    ).rejects.toBeInstanceOf(error);
  });

  it('rejects existing and concurrent duplicate relationships', async () => {
    db.findFirst
      .mockResolvedValueOnce(relationship())
      .mockResolvedValueOnce(null);
    await expect(
      service.request('counselor', { clientId: 'client' }),
    ).rejects.toBeInstanceOf(ConflictException);
    db.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.request('counselor', { clientId: 'client' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a fresh pending request when only revoked history exists', async () => {
    db.findFirst.mockResolvedValue(null);
    db.create.mockResolvedValue({ ...relationship(), id: 'new-rel' });
    await expect(
      service.request('counselor', { clientId: 'client' }),
    ).resolves.toMatchObject({ id: 'new-rel', status: Status.PENDING });
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(shares.deleteMany).not.toHaveBeenCalled();
  });

  it.each([Status.PENDING, Status.ACTIVE, Status.REJECTED])(
    'rejects an existing %s relationship including soft-deleted records',
    async (status) => {
      db.findFirst.mockResolvedValue({
        ...relationship(status),
        deletedAt: new Date(),
      });
      await expect(
        service.request('counselor', { clientId: 'client' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(db.create).not.toHaveBeenCalled();
      expect(db.findFirst).toHaveBeenCalledWith({
        where: {
          counselorId: 'counselor',
          clientId: 'client',
          status: { not: Status.REVOKED },
        },
      });
    },
  );

  it('lists both sides for a user with active client and counselor roles', async () => {
    await service.findMine({
      userId: 'caller',
      roles: [RoleCode.CLIENT, RoleCode.COUNSELOR],
    });
    expect(users.findById).not.toHaveBeenCalled();
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ counselorId: 'caller' }, { clientId: 'caller' }],
          deletedAt: null,
        },
      }),
    );
  });

  it('allows a dual-role user to request as counselor and respond as client', async () => {
    const dual = person(RoleCode.CLIENT, {
      roleAssignments: [
        assignment(RoleCode.CLIENT),
        assignment(RoleCode.COUNSELOR),
      ],
    });
    users.findById.mockImplementation((id: string) =>
      Promise.resolve(id === 'caller' ? dual : person(RoleCode.CLIENT)),
    );
    db.findFirst.mockResolvedValueOnce(null);
    db.create.mockResolvedValue(relationship());
    await expect(
      service.request('caller', { clientId: 'another-client' }),
    ).resolves.toEqual(relationship());
    db.findFirst.mockResolvedValue({ ...relationship(), clientId: 'caller' });
    await expect(
      service.respond('caller', 'rel', { status: Status.ACTIVE }),
    ).resolves.toMatchObject({ clientId: 'caller' });
  });

  it('ignores a revoked role even when the legacy role still names it', async () => {
    const user = {
      userId: 'caller',
      roles: [RoleCode.CLIENT],
      role: RoleCode.COUNSELOR,
    };
    await service.findMine(user);
    expect(users.findById).not.toHaveBeenCalled();
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'caller', deletedAt: null },
      }),
    );
    users.findById.mockResolvedValue(
      person(RoleCode.COUNSELOR, {
        roleAssignments: [
          assignment(RoleCode.COUNSELOR, new Date()),
          assignment(RoleCode.CLIENT),
        ],
      }),
    );
    await expect(
      service.request('caller', { clientId: 'client' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    [RoleCode.COUNSELOR, 'counselorId'],
    [RoleCode.CLIENT, 'clientId'],
  ])(
    'lists only the %s participant’s non-deleted relationships',
    async (role, field) => {
      await service.findMine({ userId: 'caller', roles: [role] });
      expect(users.findById).not.toHaveBeenCalled();
      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { [field]: 'caller', deletedAt: null },
          orderBy: { createdAt: 'desc' },
        }),
      );
    },
  );

  it.each([Status.ACTIVE, Status.REJECTED])(
    'lets the intended client respond %s',
    async (status) => {
      await service.respond('client', 'rel', { status });
      expect(db.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'rel',
          clientId: 'client',
          status: Status.PENDING,
          deletedAt: null,
        },
        data: { status, respondedAt: expect.any(Date) as Date },
      });
    },
  );

  it.each(['counselor', 'other'])('prevents %s from responding', async (id) => {
    await expect(
      service.respond(id, 'rel', { status: Status.ACTIVE }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it.each(['counselor', 'client'])(
    'lets %s revoke an active relationship',
    async (id) => {
      db.findFirst.mockResolvedValue(relationship(Status.ACTIVE));
      await service.revoke(id, 'rel');
      expect(shares.deleteMany).toHaveBeenCalledWith({
        where: { relationshipId: 'rel' },
      });
      expect(db.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'rel',
          status: Status.ACTIVE,
          deletedAt: null,
          OR: [{ counselorId: id }, { clientId: id }],
        },
        data: { status: Status.REVOKED, endedAt: expect.any(Date) as Date },
      });
    },
  );

  it('prevents an unrelated user from revoking', async () => {
    db.findFirst.mockResolvedValue(relationship(Status.ACTIVE));
    await expect(service.revoke('other', 'rel')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing user', null],
    ['inactive user', person(RoleCode.CLIENT, { status: 'INACTIVE' })],
    ['deleted user', person(RoleCode.CLIENT, { deletedAt: new Date() })],
    ['missing role', person(RoleCode.CLIENT, { roleAssignments: [] })],
    [
      'deleted role',
      person(RoleCode.CLIENT, {
        roleAssignments: [assignment(RoleCode.CLIENT, null, new Date())],
      }),
    ],
  ])('rejects %s before either mutation', async (_label, user) => {
    users.findById.mockResolvedValue(user);
    await expect(
      service.respond('client', 'rel', { status: Status.ACTIVE }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.revoke('client', 'rel')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.findFirst).not.toHaveBeenCalled();
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it('rejects invalid transitions and concurrent changes', async () => {
    db.findFirst.mockResolvedValue(relationship(Status.REJECTED));
    await expect(
      service.respond('client', 'rel', { status: Status.ACTIVE }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.revoke('client', 'rel')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    db.findFirst.mockResolvedValue(relationship());
    db.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.respond('client', 'rel', { status: Status.ACTIVE }),
    ).rejects.toBeInstanceOf(BadRequestException);
    db.findFirst.mockResolvedValue(relationship(Status.ACTIVE));
    await expect(service.revoke('client', 'rel')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.findFirst).toHaveBeenCalledTimes(4);
  });

  it('excludes soft-deleted relationships from response and revocation', async () => {
    db.findFirst.mockResolvedValue(null);
    await expect(
      service.respond('client', 'rel', { status: Status.ACTIVE }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.revoke('client', 'rel')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { id: 'rel', deletedAt: null },
    });
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing', roleAssignments: [] },
    {
      label: 'deleted',
      roleAssignments: [assignment(RoleCode.COUNSELOR, null, new Date())],
    },
    {
      label: 'revoked',
      roleAssignments: [assignment(RoleCode.COUNSELOR, new Date())],
    },
  ])(
    'rejects $label roles for request and list',
    async ({ roleAssignments }) => {
      await expect(
        service.findMine({ userId: 'counselor', roles: [] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.findById).not.toHaveBeenCalled();
      users.findById.mockResolvedValue(
        person(RoleCode.COUNSELOR, { roleAssignments }),
      );
      await expect(
        service.request('counselor', { clientId: 'client' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.findMany).not.toHaveBeenCalled();
      expect(db.create).not.toHaveBeenCalled();
    },
  );

  it.each(['respond', 'revoke'] as const)(
    'excludes a deleted relationship in the post-%s read',
    async (operation) => {
      db.findFirst.mockResolvedValue(
        relationship(operation === 'respond' ? Status.PENDING : Status.ACTIVE),
      );
      db.findFirst
        .mockResolvedValueOnce(
          relationship(
            operation === 'respond' ? Status.PENDING : Status.ACTIVE,
          ),
        )
        .mockResolvedValueOnce(null);
      const result =
        operation === 'respond'
          ? service.respond('client', 'rel', { status: Status.ACTIVE })
          : service.revoke('client', 'rel');
      await expect(result).rejects.toBeInstanceOf(NotFoundException);
      expect(db.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: 'rel', deletedAt: null } }),
      );
    },
  );
});
