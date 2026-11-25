import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CareRelationshipStatus, Prisma, RoleCode } from '@prisma/client';

import { PrismaService } from '@/core/prisma/prisma.service';
import {
  counselorEligibility,
  lockEligibleCounselor,
  requireEligibleCounselor,
} from '../counselors/counselor-eligibility';
import {
  type CurrentUser,
  hasCurrentRole,
  UsersService,
} from '../users/users.service';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { RespondRelationshipDto } from './dto/respond-relationship.dto';

@Injectable()
export class RelationshipsService {
  private readonly relationshipInclude = {
    counselor: {
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        role: {
          select: {
            code: true,
          },
        },
      },
    },
    client: {
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        role: {
          select: {
            code: true,
          },
        },
      },
    },
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async request(counselorId: string, dto: CreateRelationshipDto) {
    await requireEligibleCounselor(this.prisma, counselorId);

    if (counselorId === dto.clientId) {
      throw new BadRequestException(
        'Counselor cannot request a relationship with themselves',
      );
    }

    const client = await this.usersService.findById(dto.clientId);

    if (!client || client.deletedAt) {
      throw new NotFoundException('Client not found');
    }

    if (!this.hasRole(client, RoleCode.CLIENT)) {
      throw new BadRequestException('Target user must be a client');
    }

    const existingRelationship = await this.prisma.careRelationship.findFirst({
      where: {
        counselorId,
        clientId: dto.clientId,
        status: { not: CareRelationshipStatus.REVOKED },
      },
    });

    if (existingRelationship) {
      throw new ConflictException('Relationship already exists');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockEligibleCounselor(tx, counselorId);
        return tx.careRelationship.create({
          data: {
            counselorId,
            clientId: dto.clientId,
            status: CareRelationshipStatus.PENDING,
          },
          include: this.relationshipInclude,
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Relationship already exists');
      }

      throw error;
    }
  }

  async findMine(
    user: Pick<CurrentUser, 'userId' | 'roles' | 'counselorEligible'>,
  ) {
    const { userId } = user;
    const counselor = user.counselorEligible;
    const client = hasCurrentRole(user, RoleCode.CLIENT);
    if (!counselor && !client) {
      throw new ForbiddenException(
        'Only approved counselors and clients can access relationships',
      );
    }

    const participation: Prisma.CareRelationshipWhereInput[] = [];
    if (counselor)
      participation.push({
        counselorId: userId,
        counselor: counselorEligibility,
      });
    if (client) participation.push({ clientId: userId });

    return this.prisma.careRelationship.findMany({
      where: {
        OR: participation,
        deletedAt: null,
      },
      include: this.relationshipInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async respond(userId: string, id: string, dto: RespondRelationshipDto) {
    const user = await this.requireActiveParticipant(userId);
    const relationship = await this.prisma.careRelationship.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!relationship) {
      throw new NotFoundException('Relationship not found');
    }

    if (
      relationship.clientId !== userId ||
      !this.hasRole(user, RoleCode.CLIENT)
    ) {
      throw new ForbiddenException(
        'Only the client can respond to this relationship',
      );
    }

    if (relationship.status !== CareRelationshipStatus.PENDING) {
      throw new BadRequestException('Relationship is not pending');
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.status === CareRelationshipStatus.ACTIVE)
        await lockEligibleCounselor(tx, relationship.counselorId);
      const result = await tx.careRelationship.updateMany({
        where: {
          id,
          clientId: userId,
          status: CareRelationshipStatus.PENDING,
          deletedAt: null,
        },
        data: {
          status: dto.status,
          respondedAt: new Date(),
        },
      });

      if (result.count === 0) {
        throw new BadRequestException('Relationship is not pending');
      }

      const updated = await tx.careRelationship.findFirst({
        where: { id, deletedAt: null },
        include: this.relationshipInclude,
      });
      if (!updated) throw new NotFoundException('Relationship not found');
      return updated;
    });
  }

  async shareableCounselors(user: Pick<CurrentUser, 'userId' | 'roles'>) {
    if (!hasCurrentRole(user, RoleCode.CLIENT)) {
      throw new ForbiddenException('Only clients can select counselors');
    }
    const relationships = await this.prisma.careRelationship.findMany({
      where: {
        clientId: user.userId,
        status: CareRelationshipStatus.ACTIVE,
        deletedAt: null,
        counselor: counselorEligibility,
      },
      select: {
        id: true,
        counselor: {
          select: { id: true, firstName: true, lastName: true, username: true },
        },
      },
    });
    return {
      counselors: relationships.map(({ id, counselor }) => ({
        relationshipId: id,
        counselor,
      })),
    };
  }

  async revoke(userId: string, id: string) {
    const user = await this.requireActiveParticipant(userId);
    const relationship = await this.prisma.careRelationship.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!relationship) {
      throw new NotFoundException('Relationship not found');
    }

    const asCounselor =
      relationship.counselorId === userId &&
      this.hasRole(user, RoleCode.COUNSELOR);
    const asClient =
      relationship.clientId === userId && this.hasRole(user, RoleCode.CLIENT);
    if (!asCounselor && !asClient) {
      throw new ForbiddenException('You are not part of this relationship');
    }

    if (relationship.status !== CareRelationshipStatus.ACTIVE) {
      throw new BadRequestException('Only active relationships can be revoked');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (!asClient) await lockEligibleCounselor(tx, userId);
      const result = await tx.careRelationship.updateMany({
        where: {
          id,
          status: CareRelationshipStatus.ACTIVE,
          deletedAt: null,
          OR: [{ counselorId: userId }, { clientId: userId }],
        },
        data: {
          status: CareRelationshipStatus.REVOKED,
          endedAt: new Date(),
        },
      });

      if (result.count === 0) {
        throw new BadRequestException(
          'Only active relationships can be revoked',
        );
      }

      await tx.journalShare.deleteMany({ where: { relationshipId: id } });
      const updated = await tx.careRelationship.findFirst({
        where: { id, deletedAt: null },
        include: this.relationshipInclude,
      });
      if (!updated) throw new NotFoundException('Relationship not found');
      return updated;
    });
    return updated;
  }

  private async requireActiveParticipant(userId: string) {
    const user = await this.usersService.findById(userId);
    if (
      !user ||
      user.deletedAt ||
      user.status !== 'ACTIVE' ||
      !user.roleAssignments.some(
        (assignment) => !assignment.revokedAt && !assignment.role.deletedAt,
      )
    ) {
      throw new ForbiddenException('User is not active');
    }
    return user;
  }

  private hasRole(
    user: NonNullable<Awaited<ReturnType<UsersService['findById']>>>,
    role: RoleCode,
  ) {
    return user.roleAssignments.some(
      (assignment) =>
        !assignment.revokedAt &&
        !assignment.role.deletedAt &&
        assignment.role.code === role,
    );
  }
}
