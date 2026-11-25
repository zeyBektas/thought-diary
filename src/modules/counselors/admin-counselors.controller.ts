import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { CurrentUser } from '../users/users.service';
import { CounselorProfilesService } from './counselor-profiles.service';
import { CounselorDecisionReasonDto } from './dto/counselor-profile.dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';

type AuthenticatedRequest = Request & { user: CurrentUser };

@Controller('admin/counselors')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminCounselorsController {
  constructor(private readonly profiles: CounselorProfilesService) {}

  @Get()
  list() {
    return this.profiles.listForReview();
  }

  @Get(':id')
  review(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.findForReview(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profiles.decide(request.user.userId, id, { kind: 'approve' });
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CounselorDecisionReasonDto,
  ) {
    return this.profiles.decide(request.user.userId, id, {
      kind: 'reject',
      reason: dto.reason,
    });
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CounselorDecisionReasonDto,
  ) {
    return this.profiles.decide(request.user.userId, id, {
      kind: 'suspend',
      reason: dto.reason,
    });
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  reinstate(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CounselorDecisionReasonDto,
  ) {
    return this.profiles.decide(request.user.userId, id, {
      kind: 'reinstate',
      reason: dto.reason,
    });
  }

  @Get(':id/history')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.history(id);
  }
}
