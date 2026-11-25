import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';

import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { BCRYPT_HASH_ROUNDS } from './auth.constants';
import { Prisma, RoleCode, UserStatus } from '@prisma/client';
import { PrismaService } from '@/core/prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const email = registerDto.email.trim().toLowerCase();

    // Check if user already exists
    const existingUser = await this.usersService.findByEmail(email);

    if (existingUser) {
      throw new ConflictException('Email is already registered');
    }

    // Find CLIENT role
    const clientRole = await this.prisma.role.findUnique({
      where: {
        code: RoleCode.CLIENT,
      },
    });

    if (!clientRole || clientRole.deletedAt) {
      throw new InternalServerErrorException('CLIENT role is not configured');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(
      registerDto.password,
      BCRYPT_HASH_ROUNDS,
    );

    // Create user
    const user = await this.usersService.create({
      email,
      passwordHash,
      firstName: registerDto.firstName.trim(),
      lastName: registerDto.lastName.trim(),
      username: registerDto.username?.trim(),
      phone: registerDto.phone?.trim(),
      roleId: clientRole.id,
    });

    const tokens = await this.generateTokens(user);

    return {
      user: this.getSafeUser(user),
      ...tokens,
    };
  }

  async login(loginDto: LoginDto) {
    const email = loginDto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('User is not active');
    }

    const tokens = await this.generateTokens(user);

    return {
      user: this.getSafeUser(user),
      ...tokens,
    };
  }

  private async generateTokens(
    user: Awaited<ReturnType<UsersService['create']>>,
  ) {
    const { tokens, data } = await this.prepareTokens(user);
    await this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, user.id);
      if (!account || account.status !== 'ACTIVE' || account.deletedAt) {
        throw new UnauthorizedException('User is not active');
      }
      await tx.refreshToken.create({ data });
    });
    return tokens;
  }

  private async prepareTokens(
    user: Awaited<ReturnType<UsersService['create']>>,
  ) {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
    });

    const tokenId = randomUUID();

    const refreshToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        jti: tokenId,
        type: 'refresh',
      },
      {
        secret: process.env.JWT_REFRESH_SECRET!,
        expiresIn: '30d',
      },
    );

    const tokenHash = await bcrypt.hash(refreshToken, BCRYPT_HASH_ROUNDS);

    return {
      data: {
        id: tokenId,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      tokens: { accessToken, refreshToken },
    };
  }

  async refresh(refreshToken: string) {
    let payload: {
      sub: string;
      jti: string;
      type: string;
    };

    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET!,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const storedToken = await this.prisma.refreshToken.findUnique({
      where: {
        id: payload.jti,
      },
    });

    if (
      !storedToken ||
      storedToken.userId !== payload.sub ||
      storedToken.revokedAt ||
      storedToken.deletedAt ||
      storedToken.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const isValid = await bcrypt.compare(refreshToken, storedToken.tokenHash);

    if (!isValid) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.findById(payload.sub);

    if (!user || user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('User is not active');
    }

    const { tokens, data } = await this.prepareTokens(user);
    await this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, payload.sub);
      if (!account || account.status !== 'ACTIVE' || account.deletedAt) {
        throw new UnauthorizedException('User is not active');
      }
      const now = new Date();
      const consumed = await tx.refreshToken.updateMany({
        where: {
          id: storedToken.id,
          userId: payload.sub,
          revokedAt: null,
          deletedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      if (consumed.count !== 1) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      await tx.refreshToken.create({ data });
    });

    return tokens;
  }

  async logout(refreshToken: string) {
    let payload: {
      jti: string;
    };

    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET!,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.updateMany({
      where: {
        id: payload.jti,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return {
      message: 'Logged out successfully',
    };
  }

  // Internal foundation for future administration; no public suspension endpoint.
  // The same account-row lock is held during token issuance and rotation.
  async suspendAccount(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, userId);
      if (!account || account.deletedAt) {
        throw new NotFoundException('User not found');
      }
      await tx.user.update({
        where: { id: userId },
        data: { status: UserStatus.SUSPENDED },
      });
      return this.revokeAllRefreshTokensInTransaction(tx, userId);
    });
  }

  async revokeAllRefreshTokens(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, userId);
      if (!account) throw new NotFoundException('User not found');
      return this.revokeAllRefreshTokensInTransaction(tx, userId);
    });
  }

  private lockAccount(tx: Prisma.TransactionClient, userId: string) {
    return tx.$queryRaw<Array<{ status: UserStatus; deletedAt: Date | null }>>`
      SELECT status, "deletedAt" FROM users WHERE id = ${userId} FOR UPDATE
    `.then((rows) => rows[0]);
  }

  private revokeAllRefreshTokensInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
  ) {
    return tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private getSafeUser(user: Awaited<ReturnType<UsersService['create']>>) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      status: user.status,
      // Legacy compatibility only; this may be stale or revoked. Never use it
      // for authorization; `roles` contains the current assignments.
      role: user.role,
      roles: user.roleAssignments.map(({ role }) => role.code),
    };
  }
}
