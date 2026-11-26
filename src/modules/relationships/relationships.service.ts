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
  eligibleOrganizationRelationshipIds,
  lockRelationshipOrganization,
} from '../organizations/organization-context';
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

    if (!client || client.deletedAt || client.status !== 'ACTIVE') {
      throw new NotFoundException('Client not found');
    }

    if (!this.hasRole(client, RoleCode.CLIENT)) {
      throw new BadRequestException('Target user must be a client');
    }

    const organizationId = dto.organizationId ?? null;
    const pair = {
      counselorId,
      clientId: dto.clientId,
      organizationId,
      status: { not: CareRelationshipStatus.REVOKED },
    };
    if (
      organizationId === null &&
      (await this.prisma.careRelationship.findFirst({ where: pair }))
    )
      throw new ConflictException('Relationship already exists');

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockRelationshipOrganization(
          tx,
          organizationId,
          dto.clientId,
          counselorId,
        );
        await lockEligibleCounselor(tx, counselorId);
        if (
          organizationId !== null &&
          (await tx.careRelationship.findFirst({ where: pair }))
        )
          throw new ConflictException('Relationship already exists');
        const relationship = await tx.careRelationship.create({
          data: {
            counselorId,
            clientId: dto.clientId,
            organizationId,
            status: CareRelationshipStatus.PENDING,
          },
          include: this.relationshipInclude,
        });
        await this.auditScopedTransition(tx, counselorId, relationship);
        return relationship;
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

    return this.prisma.$transaction(
      async (tx) => {
        const eligible = await eligibleOrganizationRelationshipIds(tx, {
          participantId: userId,
        });
        return tx.careRelationship.findMany({
          where: {
            OR: participation,
            deletedAt: null,
            AND: [{ OR: [{ organizationId: null }, { id: { in: eligible } }] }],
          },
          include: this.relationshipInclude,
          orderBy: { createdAt: 'desc' },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
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
      await lockRelationshipOrganization(
        tx,
        relationship.organizationId,
        relationship.clientId,
        relationship.counselorId,
      );
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
      await this.auditScopedTransition(
        tx,
        userId,
        updated,
        relationship.status,
      );
      return updated;
    });
  }

  async shareableCounselors(user: Pick<CurrentUser, 'userId' | 'roles'>) {
    if (!hasCurrentRole(user, RoleCode.CLIENT)) {
      throw new ForbiddenException('Only clients can select counselors');
    }
    const relationships = await this.prisma.$transaction(
      async (tx) => {
        const eligible = await eligibleOrganizationRelationshipIds(tx, {
          clientId: user.userId,
        });
        return tx.careRelationship.findMany({
          where: {
            clientId: user.userId,
            status: CareRelationshipStatus.ACTIVE,
            deletedAt: null,
            counselor: counselorEligibility,
            OR: [{ organizationId: null }, { id: { in: eligible } }],
          },
          select: {
            id: true,
            organizationId: true,
            counselor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
              },
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      counselors: relationships.map(({ id, organizationId, counselor }) => ({
        relationshipId: id,
        ...(organizationId && { organizationId }),
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
      await lockRelationshipOrganization(
        tx,
        relationship.organizationId,
        relationship.clientId,
        relationship.counselorId,
      );
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
      await this.auditScopedTransition(
        tx,
        userId,
        updated,
        relationship.status,
      );
      return updated;
    });
    return updated;
  }

  private async auditScopedTransition(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    relationship: {
      id: string;
      organizationId: string | null;
      status: CareRelationshipStatus;
    },
    previous?: CareRelationshipStatus,
  ) {
    if (relationship.organizationId === null) return;
    await tx.auditLog.create({
      data: {
        actorUserId,
        organizationId: relationship.organizationId,
        action: 'ORGANIZATION_RELATIONSHIP_' + relationship.status,
        targetId: relationship.id,
        targetType: 'CARE_RELATIONSHIP',
        result: 'SUCCESS',
        metadata: { from: previous ?? null, to: relationship.status },
      },
    });
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
