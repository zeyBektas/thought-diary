import { Test, TestingModule } from '@nestjs/testing';
import { RoleCode } from '@prisma/client';
import { PrismaService } from '@/core/prisma/prisma.service';
import { UsersService } from '@/modules/users/users.service';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { BCRYPT_HASH_ROUNDS } from './auth.constants';
import { UnauthorizedException } from '@nestjs/common';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('bcrypt-hash'),
  compare: jest.fn().mockResolvedValue(true),
}));

describe('AuthService', () => {
  let service: AuthService;
  const prisma = {
    role: { findUnique: jest.fn() },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { update: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  const usersService = {
    findByEmail: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
  };
  const jwtService = { signAsync: jest.fn(), verifyAsync: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma.$queryRaw.mockResolvedValue([{ status: 'ACTIVE', deletedAt: null }]);
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('always assigns CLIENT during public registration, even if an extra role is supplied', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'client-role' });
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockResolvedValue({
      id: 'user-id',
      email: 'client@example.com',
      username: null,
      firstName: 'First',
      lastName: 'Last',
      phone: null,
      status: 'ACTIVE',
      roleId: 'client-role',
      role: { id: 'client-role', code: RoleCode.CLIENT },
      roleAssignments: [
        {
          roleId: 'client-role',
          role: { id: 'client-role', code: RoleCode.CLIENT },
        },
      ],
    });
    jwtService.signAsync
      .mockResolvedValueOnce('access-token')
      .mockResolvedValueOnce('refresh-token');
    prisma.refreshToken.create.mockResolvedValue({});

    const registrationInput = {
      email: 'client@example.com',
      password: 'secure-password',
      firstName: 'First',
      lastName: 'Last',
      role: RoleCode.COUNSELOR,
    };
    const result = await service.register(registrationInput);

    expect(bcrypt.hash).toHaveBeenCalledWith(
      registrationInput.password,
      BCRYPT_HASH_ROUNDS,
    );
    expect(usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: 'client-role' }),
    );
    expect(result.user.role?.code).toBe(RoleCode.CLIENT);
    expect(result.user.roles).toEqual([RoleCode.CLIENT]);
  });

  describe('refresh', () => {
    const user = {
      id: 'user-id',
      email: 'client@example.com',
      status: 'ACTIVE',
      role: { code: RoleCode.CLIENT },
    };
    const token = {
      id: 'token-id',
      userId: user.id,
      tokenHash: 'hash',
      revokedAt: null,
      deletedAt: null,
      expiresAt: new Date('2100-01-01'),
    };
    beforeEach(() => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: user.id,
        jti: token.id,
        type: 'refresh',
      });
      jwtService.signAsync.mockResolvedValue('signed');
      jest.mocked(bcrypt.compare).mockResolvedValue(true as never);
      usersService.findById.mockResolvedValue(user);
      prisma.refreshToken.findUnique.mockResolvedValue(token);
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.refreshToken.create.mockResolvedValue({});
      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) =>
          callback(prisma),
      );
    });

    it('conditionally consumes and persists a replacement in a transaction', async () => {
      await expect(service.refresh('input')).resolves.toEqual({
        accessToken: 'signed',
        refreshToken: 'signed',
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          id: token.id,
          userId: user.id,
          revokedAt: null,
          deletedAt: null,
          expiresAt: { gt: expect.any(Date) as Date },
        },
        data: { revokedAt: expect.any(Date) as Date },
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: user.id,
          tokenHash: 'bcrypt-hash',
        }) as unknown,
      });
    });

    it('rejects a token consumed concurrently without creating a replacement', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.refresh('input')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', null],
      ['expired', { ...token, expiresAt: new Date(0) }],
      ['revoked', { ...token, revokedAt: new Date() }],
      ['deleted', { ...token, deletedAt: new Date() }],
      ['wrong user', { ...token, userId: 'other' }],
    ])('rejects %s tokens', async (_label, stored) => {
      prisma.refreshToken.findUnique.mockResolvedValue(stored);
      await expect(service.refresh('input')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a token with an invalid hash', async () => {
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);
      await expect(service.refresh('input')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it('suspends a user and revokes refresh tokens in one locked transaction', async () => {
    prisma.user.update.mockResolvedValue({});
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
    await expect(service.suspendAccount('user-id')).resolves.toEqual({
      count: 2,
    });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-id' },
      data: { status: 'SUSPENDED' },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-id', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
  });

  it('does not persist a refresh token if the account is suspended while login is in progress', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: 'user-id',
      status: 'ACTIVE',
      deletedAt: null,
      passwordHash: 'hash',
    });
    jwtService.signAsync.mockResolvedValue('signed');
    prisma.$queryRaw.mockResolvedValue([
      { status: 'SUSPENDED', deletedAt: null },
    ]);
    await expect(
      service.login({ email: 'client@example.com', password: 'password' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('keeps the legacy login role for compatibility while reporting only current roles', async () => {
    jest.mocked(bcrypt.compare).mockResolvedValue(true as never);
    usersService.findByEmail.mockResolvedValue({
      id: 'user-id',
      email: 'client@example.com',
      status: 'ACTIVE',
      deletedAt: null,
      passwordHash: 'hash',
      roleId: 'client-role',
      role: { id: 'client-role', code: RoleCode.CLIENT },
      roleAssignments: [
        {
          roleId: 'counselor-role',
          role: { id: 'counselor-role', code: RoleCode.COUNSELOR },
        },
      ],
    });
    jwtService.signAsync.mockResolvedValue('signed');
    const result = await service.login({
      email: 'client@example.com',
      password: 'password',
    });
    expect(result.user.role.code).toBe(RoleCode.CLIENT);
    expect(result.user.roles).toEqual([RoleCode.COUNSELOR]);
  });
});
