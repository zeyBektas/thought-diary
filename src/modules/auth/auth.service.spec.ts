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
      role: { id: 'client-role', code: RoleCode.CLIENT },
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
    expect(result.user.role.code).toBe(RoleCode.CLIENT);
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
});
