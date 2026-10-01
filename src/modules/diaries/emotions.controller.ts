import { Controller, Get, UseGuards } from '@nestjs/common';

import { PrismaService } from '@/core/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('emotions')
@UseGuards(JwtAuthGuard)
export class EmotionsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  findAll() {
    return this.prisma.emotion.findMany({
      where: {
        deletedAt: null,
      },
      select: {
        id: true,
        code: true,
        parentId: true,
      },
      orderBy: [{ parentId: 'asc' }, { code: 'asc' }],
    });
  }
}
