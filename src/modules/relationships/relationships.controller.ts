import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { RespondRelationshipDto } from './dto/respond-relationship.dto';
import { RelationshipsService } from './relationships.service';

@Controller('relationships')
@UseGuards(JwtAuthGuard)
export class RelationshipsController {
  constructor(private readonly relationshipsService: RelationshipsService) {}

  @Post()
  request(
    @Req() request: Request & { user: { userId: string } },
    @Body() dto: CreateRelationshipDto,
  ) {
    return this.relationshipsService.request(request.user.userId, dto);
  }

  @Get()
  findMine(@Req() request: Request & { user: { userId: string } }) {
    return this.relationshipsService.findMine(request.user.userId);
  }

  @Patch(':id')
  respond(
    @Req() request: Request & { user: { userId: string } },
    @Param('id') id: string,
    @Body() dto: RespondRelationshipDto,
  ) {
    return this.relationshipsService.respond(request.user.userId, id, dto);
  }

  @Patch(':id/revoke')
  revoke(
    @Req() request: Request & { user: { userId: string } },
    @Param('id') id: string,
  ) {
    return this.relationshipsService.revoke(request.user.userId, id);
  }
}
