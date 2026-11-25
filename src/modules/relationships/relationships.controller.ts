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
import type { CurrentUser } from '../users/users.service';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { RespondRelationshipDto } from './dto/respond-relationship.dto';
import { RelationshipsService } from './relationships.service';

type AuthenticatedRequest = Request & { user: CurrentUser };

@Controller('relationships')
@UseGuards(JwtAuthGuard)
export class RelationshipsController {
  constructor(private readonly relationshipsService: RelationshipsService) {}

  @Post()
  request(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateRelationshipDto,
  ) {
    return this.relationshipsService.request(request.user.userId, dto);
  }

  @Get()
  findMine(@Req() request: AuthenticatedRequest) {
    return this.relationshipsService.findMine(request.user);
  }

  @Get('shareable-counselors')
  shareableCounselors(@Req() request: AuthenticatedRequest) {
    return this.relationshipsService.shareableCounselors(request.user);
  }

  @Patch(':id')
  respond(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RespondRelationshipDto,
  ) {
    return this.relationshipsService.respond(request.user.userId, id, dto);
  }

  @Patch(':id/revoke')
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.relationshipsService.revoke(request.user.userId, id);
  }
}
