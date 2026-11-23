import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CounselorDiariesService } from './counselor-diaries.service';
import { ListCounselorDiariesDto } from './dto/list-counselor-diaries.dto';

@Controller('counselor/diaries')
@UseGuards(JwtAuthGuard)
export class CounselorDiariesController {
  constructor(private readonly service: CounselorDiariesService) {}

  @Get()
  list(
    @Req() req: Request & { user: { userId: string } },
    @Query() query: ListCounselorDiariesDto,
  ) {
    return this.service.list(req.user.userId, query);
  }

  @Get(':id')
  detail(
    @Req() req: Request & { user: { userId: string } },
    @Param('id') id: string,
  ) {
    return this.service.detail(req.user.userId, id);
  }
}
