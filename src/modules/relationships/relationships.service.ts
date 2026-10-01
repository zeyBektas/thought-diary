import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CareRelationshipStatus, Prisma, RoleCode } from '@prisma/client';

import { PrismaService } from '@/core/prisma/prisma.service';
import { UsersService } from '../users/users.service';
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
    const counselor = await this.usersService.findById(counselorId);

    if (
      !counselor ||
      counselor.deletedAt ||
      counselor.status !== 'ACTIVE' ||
      counselor.role.code !== RoleCode.COUNSELOR
    ) {
      throw new ForbiddenException('Only active counselors can request relationships');
    }

    if (counselorId === dto.clientId) {
      throw new BadRequestException(
        'Counselor cannot request a relationship with themselves',
      );
    }

    const client = await this.usersService.findById(dto.clientId);

    if (!client || client.deletedAt) {
      throw new NotFoundException('Client not found');
    }

    if (client.role.code !== RoleCode.CLIENT) {
      throw new BadRequestException('Target user must be a client');
    }

    const existingRelationship =
      await this.prisma.careRelationship.findUnique({
        where: {
          counselorId_clientId: {
            counselorId,
            clientId: dto.clientId,
          },
        },
      });

    if (existingRelationship) {
      throw new ConflictException('Relationship already exists');
    }

    try {
      return await this.prisma.careRelationship.create({
        data: {
          counselorId,
          clientId: dto.clientId,
          status: CareRelationshipStatus.PENDING,
        },
        include: this.relationshipInclude,
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

  async findMine(userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new ForbiddenException('User is not active');
    }

    let where: Prisma.CareRelationshipWhereInput;

    if (user.role.code === RoleCode.COUNSELOR) {
      where = { counselorId: userId };
    } else if (user.role.code === RoleCode.CLIENT) {
      where = { clientId: userId };
    } else {
      throw new ForbiddenException('Only counselors and clients can access relationships');
    }

    return this.prisma.careRelationship.findMany({
      where: {
        ...where,
        deletedAt: null,
      },
      include: this.relationshipInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async respond(
    userId: string,
    id: string,
    dto: RespondRelationshipDto,
  ) {
    const relationship = await this.prisma.careRelationship.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!relationship) {
      throw new NotFoundException('Relationship not found');
    }

    if (relationship.clientId !== userId) {
      throw new ForbiddenException('Only the client can respond to this relationship');
    }

    if (relationship.status !== CareRelationshipStatus.PENDING) {
      throw new BadRequestException('Relationship is not pending');
    }

    const result = await this.prisma.careRelationship.updateMany({
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

    return this.prisma.careRelationship.findUniqueOrThrow({
      where: { id },
      include: this.relationshipInclude,
    });
  }

  async revoke(userId: string, id: string) {
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
      relationship.counselorId !== userId &&
      relationship.clientId !== userId
    ) {
      throw new ForbiddenException('You are not part of this relationship');
    }

    if (relationship.status !== CareRelationshipStatus.ACTIVE) {
      throw new BadRequestException('Only active relationships can be revoked');
    }

    const result = await this.prisma.careRelationship.updateMany({
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
      throw new BadRequestException('Only active relationships can be revoked');
    }

    return this.prisma.careRelationship.findUniqueOrThrow({
      where: { id },
      include: this.relationshipInclude,
    });
  }
}
