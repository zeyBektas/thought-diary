import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../counselors/guards/platform-admin.guard';
import type { CurrentUser } from '../users/users.service';
import {
  CreateOrganizationDto,
  CreateOrganizationMembershipDto,
  OrganizationDecisionDto,
  UpdateOrganizationPermissionDto,
} from './dto/organization.dto';
import { OrganizationsService } from './organizations.service';

type AuthenticatedRequest = Request & { user: CurrentUser };

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get('memberships/me')
  ownMemberships(@Req() request: AuthenticatedRequest) {
    return this.organizations.ownMemberships(request.user.userId);
  }

  @Get(':organizationId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizations.getForMember(request.user.userId, organizationId);
  }

  @Get(':organizationId/memberships')
  listMemberships(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizations.listMemberships(
      request.user.userId,
      organizationId,
    );
  }

  @Get(':organizationId/memberships/:membershipId')
  getMembership(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ) {
    return this.organizations.getMembership(
      request.user.userId,
      organizationId,
      membershipId,
    );
  }

  @Post(':organizationId/memberships/me/leave')
  @HttpCode(HttpStatus.OK)
  leave(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizations.leave(request.user.userId, organizationId);
  }

  @Post(':organizationId/memberships/:membershipId/suspend')
  @HttpCode(HttpStatus.OK)
  suspendMembership(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: OrganizationDecisionDto,
  ) {
    return this.organizations.manageMembership(
      request.user.userId,
      organizationId,
      membershipId,
      'SUSPENDED',
      dto.reason,
    );
  }

  @Post(':organizationId/memberships/:membershipId/remove')
  @HttpCode(HttpStatus.OK)
  removeMembership(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: OrganizationDecisionDto,
  ) {
    return this.organizations.manageMembership(
      request.user.userId,
      organizationId,
      membershipId,
      'REMOVED',
      dto.reason,
    );
  }
}

@Controller('admin/organizations')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminOrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizations.create(request.user.userId, dto);
  }

  @Get()
  list() {
    return this.organizations.listForPlatformAdmin();
  }

  @Get(':organizationId')
  get(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    return this.organizations.getForPlatformAdmin(organizationId);
  }

  @Post(':organizationId/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: OrganizationDecisionDto,
  ) {
    return this.organizations.setStatus(
      request.user.userId,
      organizationId,
      'SUSPENDED',
      dto.reason,
    );
  }

  @Post(':organizationId/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: OrganizationDecisionDto,
  ) {
    return this.organizations.setStatus(
      request.user.userId,
      organizationId,
      'ACTIVE',
      dto.reason,
    );
  }

  @Post(':organizationId/memberships')
  createMembership(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateOrganizationMembershipDto,
  ) {
    return this.organizations.createMembership(
      request.user.userId,
      organizationId,
      dto.userId,
    );
  }

  @Patch(':organizationId/memberships/:membershipId/permission')
  changePermission(
    @Req() request: AuthenticatedRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateOrganizationPermissionDto,
  ) {
    return this.organizations.changeMembershipPermission(
      request.user.userId,
      organizationId,
      membershipId,
      dto.permission,
    );
  }

  @Get(':organizationId/memberships/:membershipId/history')
  history(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ) {
    return this.organizations.membershipHistory(organizationId, membershipId);
  }
}
