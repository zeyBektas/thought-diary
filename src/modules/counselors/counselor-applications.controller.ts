import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { CurrentUser } from '../users/users.service';
import { CounselorProfilesService } from './counselor-profiles.service';
import { CounselorProfileDto } from './dto/counselor-profile.dto';

type AuthenticatedRequest = Request & { user: CurrentUser };

@Controller('counselor-applications')
@UseGuards(JwtAuthGuard)
export class CounselorApplicationsController {
  constructor(private readonly profiles: CounselorProfilesService) {}

  @Post()
  apply(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CounselorProfileDto,
  ) {
    return this.profiles.apply(request.user.userId, dto);
  }

  @Get('me')
  findMine(@Req() request: AuthenticatedRequest) {
    return this.profiles.findMine(request.user.userId);
  }

  @Patch('me')
  updateMine(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CounselorProfileDto,
  ) {
    return this.profiles.updateMine(request.user.userId, dto);
  }

  @Post('me/resubmit')
  @HttpCode(HttpStatus.OK)
  resubmit(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CounselorProfileDto,
  ) {
    return this.profiles.resubmit(request.user.userId, dto);
  }
}
