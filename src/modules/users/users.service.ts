import { PrismaService } from '@/core/prisma/prisma.service';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { RoleCode } from '@prisma/client';

// Authorization always uses the current resolved role collection, never the
// legacy compatibility role or a token claim.
export function hasCurrentRole(
  user: { roles: readonly RoleCode[] },
  role: RoleCode,
): boolean {
  return user.roles.includes(role);
}

export type CurrentUser = Awaited<
  ReturnType<UsersService['resolveCurrentUser']>
>;

const activeRoleAssignment = { revokedAt: null, role: { deletedAt: null } };

const userRelations = {
  role: true,
  organization: true,
  roleAssignments: {
    where: activeRoleAssignment,
    include: { role: true },
  },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
      include: userRelations,
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: {
        id,
      },
      include: userRelations,
    });
  }

  async resolveCurrentUser(id: string) {
    if (typeof id !== 'string' || !id) {
      throw new UnauthorizedException('Invalid user identity');
    }
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        deletedAt: true,
        role: { select: { code: true } },
        roleAssignments: {
          where: activeRoleAssignment,
          select: { role: { select: { code: true } } },
        },
      },
    });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User is not active');
    }
    return {
      userId: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      status: user.status,
      roles: user.roleAssignments.map(({ role }) => role.code),
      // Legacy compatibility only: this value may be stale or revoked and must
      // never be used for authorization. `roles` is the current collection.
      role: user.role.code,
    };
  }

  async create(data: {
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    username?: string;
    phone?: string;
    roleId: string;
  }) {
    const existingUser = await this.findByEmail(data.email);

    if (existingUser) {
      throw new ConflictException('Email is already registered');
    }

    return this.prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        passwordHash: data.passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        username: data.username,
        phone: data.phone,
        roleId: data.roleId,
        roleAssignments: { create: { roleId: data.roleId } },
      },
      include: userRelations,
    });
  }
}
