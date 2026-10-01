import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core/prisma/prisma.service';
import { CreateDiaryDto } from './dto/create-diary.dto';
import { UpdateDiaryDto } from './dto/update-diary.dto';

@Injectable()
export class DiariesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, createDiaryDto: CreateDiaryDto) {
    await this.validatePrimaryEmotion(createDiaryDto.primaryEmotionId);

    return this.prisma.journal.create({
      data: {
        userId,
        ...createDiaryDto,
      },
    });
  }

  findAll(userId: string) {
    return this.prisma.journal.findMany({
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

    const result = await this.prisma.journal.updateMany({
      where: {
        id,
        userId,
        deletedAt: null,
      },
      data: updateDiaryDto,
    });

    if (result.count === 0) {
      throw new NotFoundException('Diary not found');
    }

    return this.prisma.journal.findFirst({
      where: {
        id,
        userId,
        deletedAt: null,
      },
    });
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
