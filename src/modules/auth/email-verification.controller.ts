import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { CurrentUser } from '../users/users.service';
import { EmailVerificationService } from './email-verification.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

export class ConfirmEmailVerificationDto {
  @IsString()
  @MaxLength(128)
  token!: string;
}

@Controller('auth/email-verification')
@UseGuards(JwtAuthGuard)
export class EmailVerificationController {
  constructor(private readonly verification: EmailVerificationService) {}

  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  request(@Req() request: Request & { user: CurrentUser }) {
    return this.verification.request(request.user.userId);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Req() request: Request & { user: CurrentUser },
    @Body() dto: ConfirmEmailVerificationDto,
  ) {
    return this.verification.confirm(request.user.userId, dto.token);
  }
}
