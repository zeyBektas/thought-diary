import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { DiariesService } from './diaries.service';
import { CreateDiaryDto } from './dto/create-diary.dto';
import { UpdateDiaryDto } from './dto/update-diary.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('diaries')
@UseGuards(JwtAuthGuard)
export class DiariesController {
  constructor(private readonly diariesService: DiariesService) {}

  @Post()
  create(
    @Req() request: Request & { user: { userId: string } },
    @Body() createDiaryDto: CreateDiaryDto,
  ) {
    return this.diariesService.create(request.user.userId, createDiaryDto);
  }

  @Get()
  findAll(@Req() request: Request & { user: { userId: string } }) {
    return this.diariesService.findAll(request.user.userId);
  }

  @Get(':id')
  findOne(
    @Req() request: Request & { user: { userId: string } },
    @Param('id') id: string,
  ) {
    return this.diariesService.findOne(request.user.userId, id);
  }

  @Patch(':id')
  update(
    @Req() request: Request & { user: { userId: string } },
    @Param('id') id: string,
    @Body() updateDiaryDto: UpdateDiaryDto,
  ) {
    return this.diariesService.update(
      request.user.userId,
      id,
      updateDiaryDto,
    );
  }

  @Delete(':id')
  remove(
    @Req() request: Request & { user: { userId: string } },
    @Param('id') id: string,
  ) {
    return this.diariesService.remove(request.user.userId, id);
  }
}
