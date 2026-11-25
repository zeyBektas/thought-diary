import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { JournalVisibility, Prisma, RoleCode } from '@prisma/client';
import { PrismaService } from '@/core/prisma/prisma.service';
import { CreateDiaryDto } from './dto/create-diary.dto';
import { UpdateDiaryDto } from './dto/update-diary.dto';

@Injectable()
export class DiariesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, createDiaryDto: CreateDiaryDto) {
    await this.validatePrimaryEmotion(createDiaryDto.primaryEmotionId);
    const { recipientRelationshipIds, ...data } = createDiaryDto;
    if (recipientRelationshipIds === undefined)
      return this.prisma.journal.create({
        data: { userId, ...data },
        omit: { shareRevision: true },
      });
    return this.prisma.$transaction(async (tx) => {
      await this.requireClient(tx, userId);
      this.checkVisibility(
        data.visibility ?? JournalVisibility.PRIVATE,
        recipientRelationshipIds,
      );
      await this.lockAndValidateRelationships(
        tx,
        userId,
        recipientRelationshipIds,
      );
      const journal = await tx.journal.create({
        data: { userId, ...data },
        omit: { shareRevision: true },
      });
      await this.writeShares(tx, journal.id, recipientRelationshipIds);
      return journal;
    });
  }

  findAll(userId: string) {
    return this.prisma.journal.findMany({
      omit: { shareRevision: true },
      where: {
        userId,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(userId: string, id: string) {
    const journal = await this.prisma.journal.findFirst({
      omit: { shareRevision: true },
      where: {
        id,
        userId,
        deletedAt: null,
      },
    });

    if (!journal) {
      throw new NotFoundException('Diary not found');
    }

    return journal;
  }

  async update(userId: string, id: string, updateDiaryDto: UpdateDiaryDto) {
    await this.validatePrimaryEmotion(updateDiaryDto.primaryEmotionId);
    const { recipientRelationshipIds, shareVersion, ...data } = updateDiaryDto;
    if (recipientRelationshipIds === null) {
      throw new BadRequestException('Recipients must be an array');
    }
    if (
      (recipientRelationshipIds === undefined) !==
        (shareVersion === undefined) ||
      (shareVersion !== undefined && !/^[a-f0-9]{64}$/.test(shareVersion))
    )
      throw new BadRequestException(
        'A valid shareVersion is required with recipients',
      );
    return this.prisma.$transaction(async (tx) => {
      const journal = await this.lockJournal(tx, userId, id);
      const visibility = data.visibility ?? journal.visibility;
      if (recipientRelationshipIds !== undefined) {
        await this.checkShareVersion(
          tx,
          journal.id,
          journal.shareRevision,
          recipientRelationshipIds,
          shareVersion!,
        );
        await this.requireClient(tx, userId);
        this.checkVisibility(visibility, recipientRelationshipIds);
        await this.lockAndValidateRelationships(
          tx,
          userId,
          recipientRelationshipIds,
        );
      }
      const increment =
        recipientRelationshipIds !== undefined ||
        visibility !== journal.visibility;
      const updated = await tx.journal.update({
        where: { id },
        data: {
          ...data,
          ...(increment ? { shareRevision: { increment: 1 } } : {}),
        },
        omit: { shareRevision: true },
      });
      if (
        visibility !== JournalVisibility.COUNSELOR ||
        recipientRelationshipIds !== undefined
      ) {
        await tx.journalShare.deleteMany({ where: { journalId: id } });
        if (recipientRelationshipIds?.length)
          await this.writeShares(tx, id, recipientRelationshipIds);
      }
      return updated;
    });
  }

  async getShares(userId: string, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.requireClient(tx, userId);
        const journal = await tx.journal.findFirst({
          where: { id, userId, deletedAt: null },
        });
        if (!journal) throw new NotFoundException('Diary not found');
        return this.shareResponse(
          tx,
          id,
          journal.shareRevision,
          journal.userId,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async replaceShares(
    userId: string,
    id: string,
    ids: string[],
    shareVersion: string,
  ) {
    if (
      typeof shareVersion !== 'string' ||
      !/^[a-f0-9]{64}$/.test(shareVersion)
    )
      throw new BadRequestException('Invalid shareVersion');
    return this.prisma.$transaction(async (tx) => {
      const journal = await this.lockJournal(tx, userId, id);
      await this.requireClient(tx, userId);
      await this.checkShareVersion(
        tx,
        id,
        journal.shareRevision,
        ids,
        shareVersion,
      );
      if (journal.visibility !== JournalVisibility.COUNSELOR)
        throw new BadRequestException('Diary is not counselor-visible');
      await this.lockAndValidateRelationships(tx, userId, ids);
      await tx.journalShare.deleteMany({ where: { journalId: id } });
      await this.writeShares(tx, id, ids);
      await tx.journal.update({
        where: { id },
        data: { shareRevision: { increment: 1 } },
      });
      return this.shareResponse(
        tx,
        id,
        journal.shareRevision + 1,
        journal.userId,
      );
    });
  }

  private version(journalId: string, revision: number, ids: string[]) {
    return createHash('sha256')
      .update(JSON.stringify([journalId, revision, [...ids].sort()]))
      .digest('hex');
  }

  private async checkShareVersion(
    tx: Prisma.TransactionClient,
    journalId: string,
    revision: number,
    requested: string[],
    supplied: string,
  ) {
    const before = await tx.journalShare.findMany({
      where: { journalId },
      select: { relationshipId: true },
    });
    const locks = [
      ...new Set([
        ...before.map((share) => share.relationshipId),
        ...requested,
      ]),
    ].sort();
    for (const id of locks)
      await tx.$queryRaw`SELECT id FROM care_relationships WHERE id = ${id} FOR UPDATE`;
    const current = await tx.journalShare.findMany({
      where: { journalId },
      select: { id: true },
    });
    if (
      this.version(
        journalId,
        revision,
        current.map((share) => share.id),
      ) !== supplied
    )
      throw new ConflictException('Sharing has changed; reload and try again');
  }

  private async shareResponse(
    tx: Prisma.TransactionClient,
    journalId: string,
    revision: number,
    ownerId: string,
  ) {
    const grants = await tx.journalShare.findMany({
      where: { journalId },
      select: { id: true },
    });
    const { recipients } = await this.effectiveShares(tx, journalId, ownerId);
    return {
      shareVersion: this.version(
        journalId,
        revision,
        grants.map((grant) => grant.id),
      ),
      recipients,
    };
  }

  private async lockJournal(
    tx: Prisma.TransactionClient,
    userId: string,
    id: string,
  ) {
    await tx.$queryRaw`SELECT id FROM journals WHERE id = ${id} AND "userId" = ${userId} AND "deletedAt" IS NULL FOR UPDATE`;
    const journal = await tx.journal.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!journal) throw new NotFoundException('Diary not found');
    return journal;
  }

  private async requireClient(tx: Prisma.TransactionClient, userId: string) {
    const client = await tx.user.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        deletedAt: null,
        roleAssignments: {
          some: {
            revokedAt: null,
            role: { code: RoleCode.CLIENT, deletedAt: null },
          },
        },
      },
      select: { id: true },
    });
    if (!client)
      throw new ForbiddenException('Only active clients can manage sharing');
  }

  private checkVisibility(visibility: JournalVisibility, ids: string[]) {
    if (ids.length && visibility !== JournalVisibility.COUNSELOR)
      throw new BadRequestException('Recipients require counselor visibility');
  }

  private async lockAndValidateRelationships(
    tx: Prisma.TransactionClient,
    userId: string,
    ids: string[],
  ) {
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('Duplicate recipients');
    for (const id of [...ids].sort()) {
      await tx.$queryRaw`SELECT id FROM care_relationships WHERE id = ${id} FOR UPDATE`;
    }
    await this.requireClient(tx, userId);
    const count = await tx.careRelationship.count({
      where: {
        id: { in: ids },
        clientId: userId,
        status: 'ACTIVE',
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
    });
    if (count !== ids.length)
      throw new BadRequestException('One or more recipients are not eligible');
  }

  private async writeShares(
    tx: Prisma.TransactionClient,
    journalId: string,
    ids: string[],
  ) {
    if (ids.length)
      await tx.journalShare.createMany({
        data: ids.map((relationshipId) => ({ journalId, relationshipId })),
      });
  }

  private async effectiveShares(
    tx: Prisma.TransactionClient,
    journalId: string,
    ownerId: string,
  ) {
    const shares = await tx.journalShare.findMany({
      where: {
        journalId,
        journal: { visibility: JournalVisibility.COUNSELOR, deletedAt: null },
        relationship: {
          clientId: ownerId,
          status: 'ACTIVE',
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
      },
      select: {
        relationshipId: true,
        relationship: {
          select: {
            counselor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
              },
            },
          },
        },
      },
    });
    return {
      recipients: shares.map(({ relationshipId, relationship }) => ({
        relationshipId,
        counselor: relationship.counselor,
      })),
    };
  }

  async remove(userId: string, id: string) {
    const result = await this.prisma.journal.updateMany({
      where: {
        id,
        userId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Diary not found');
    }

    return {
      message: 'Diary deleted successfully',
    };
  }

  private async validatePrimaryEmotion(primaryEmotionId?: string) {
    if (primaryEmotionId === undefined || primaryEmotionId === null) {
      return;
    }

    const emotion = await this.prisma.emotion.findFirst({
      where: {
        id: primaryEmotionId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!emotion) {
      throw new NotFoundException('Emotion not found');
    }
  }
}
