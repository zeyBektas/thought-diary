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
import { InvitationType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { normalizeEmail } from '@/core/mail/email-token';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { CurrentUser } from '../users/users.service';
import { OrganizationInvitationsService } from './organization-invitations.service';

class CreateInvitationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsEnum(InvitationType)
  type!: InvitationType;
}

class AcceptInvitationDto {
  @IsString()
  @MaxLength(128)
  token!: string;
}

type Authenticated = Request & { user: CurrentUser };

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationInvitationsController {
  constructor(private readonly invitations: OrganizationInvitationsService) {}

  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  accept(@Req() req: Authenticated, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(req.user.userId, dto.token);
  }

  @Post(':organizationId/invitations')
  create(
    @Req() req: Authenticated,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.invitations.create(
      req.user.userId,
      organizationId,
      dto.email,
      dto.type,
    );
  }

  @Get(':organizationId/invitations')
  list(
    @Req() req: Authenticated,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.invitations.list(req.user.userId, organizationId);
  }

  @Get(':organizationId/invitations/:invitationId')
  inspect(
    @Req() req: Authenticated,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ) {
    return this.invitations.inspect(
      req.user.userId,
      organizationId,
      invitationId,
    );
  }

  @Post(':organizationId/invitations/:invitationId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @Req() req: Authenticated,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ) {
    return this.invitations.change(
      req.user.userId,
      organizationId,
      invitationId,
      'resend',
    );
  }

  @Post(':organizationId/invitations/:invitationId/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Req() req: Authenticated,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ) {
    return this.invitations.change(
      req.user.userId,
      organizationId,
      invitationId,
      'revoke',
    );
  }
}
