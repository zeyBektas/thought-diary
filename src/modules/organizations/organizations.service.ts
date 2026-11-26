import { PrismaService } from '@/core/prisma/prisma.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MembershipStatus,
  OrganizationPermission,
  OrganizationStatus,
  Prisma,
  RoleCode,
} from '@prisma/client';
import type { CreateOrganizationDto } from './dto/organization.dto';
import {
  lockOrganization,
  requireActiveOrganization,
  requireActiveOrganizationMember,
} from './organization-context';
import { revokeOrganizationGrants } from './organization-revocation';

const organizationSelect = {
  id: true,
  name: true,
  description: true,
  website: true,
  logoUrl: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect;

const organizationAdminSelect = {
  ...organizationSelect,
  suspendedAt: true,
  suspendedById: true,
  suspensionReason: true,
  reactivatedAt: true,
} satisfies Prisma.OrganizationSelect;

const membershipSelect = {
  id: true,
  organizationId: true,
  userId: true,
  status: true,
  permission: true,
  acceptedAt: true,
  joinedAt: true,
  leftAt: true,
  removedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationMembershipSelect;

const membershipDirectorySelect = {
  ...membershipSelect,
  user: { select: { firstName: true, lastName: true, username: true } },
} satisfies Prisma.OrganizationMembershipSelect;

const membershipOrder = [
  { joinedAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.OrganizationMembershipOrderByWithRelationInput[];

const membershipActions = {
  SUSPENDED: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
  LEFT: 'ORGANIZATION_MEMBERSHIP_LEFT',
  REMOVED: 'ORGANIZATION_MEMBERSHIP_REMOVED',
} as const;

type MembershipEndStatus = keyof typeof membershipActions;

function isUniqueConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(actorId: string, dto: CreateOrganizationDto) {
    try {
      return await this.transaction(async (tx) => {
        await this.requirePlatformAdmin(tx, actorId);
        const organization = await tx.organization.create({
          data: {
            name: dto.name,
            description: dto.description,
            website: dto.website,
            logoUrl: dto.logoUrl,
          },
          select: organizationAdminSelect,
        });
        await this.audit(tx, actorId, organization.id, 'ORGANIZATION_CREATED', {
          to: organization.status,
        });
        return organization;
      });
    } catch (error) {
      if (isUniqueConflict(error))
        throw new ConflictException('Organization name is already in use');
      throw error;
    }
  }

  listForPlatformAdmin() {
    return this.prisma.organization.findMany({
      where: { deletedAt: null },
      select: organizationAdminSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async getForPlatformAdmin(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId, deletedAt: null },
      select: organizationAdminSelect,
    });
    if (!organization) throw new NotFoundException('Organization not found');
    return organization;
  }

  async setStatus(
    actorId: string,
    organizationId: string,
    status: OrganizationStatus,
    reason: string,
  ) {
    return this.transaction(async (tx) => {
      const organization = await lockOrganization(
        tx,
        organizationId,
        'exclusive',
      );
      await this.requirePlatformAdmin(tx, actorId);
      if (organization.status === status)
        throw new ConflictException('Organization already has this status');

      const suspending = status === OrganizationStatus.SUSPENDED;
      const now = new Date();
      const updated = await tx.organization.update({
        where: { id: organizationId },
        data: suspending
          ? {
              status,
              suspendedAt: now,
              suspendedById: actorId,
              suspensionReason: reason,
            }
          : { status, reactivatedAt: now },
        select: organizationAdminSelect,
      });
      const revocations = suspending
        ? await revokeOrganizationGrants(tx, organizationId)
        : {};
      await this.audit(
        tx,
        actorId,
        organizationId,
        suspending ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_REACTIVATED',
        { from: organization.status, to: status, reason, ...revocations },
      );
      return updated;
    });
  }

  ownMemberships(userId: string) {
    return this.prisma.organizationMembership.findMany({
      where: { userId },
      select: {
        ...membershipSelect,
        organization: {
          select: { id: true, name: true, status: true, deletedAt: true },
        },
      },
      orderBy: membershipOrder,
    });
  }

  getForMember(actorId: string, organizationId: string) {
    return this.transaction(async (tx) => {
      await this.lockActiveOrganization(tx, organizationId, 'shared');
      await requireActiveOrganizationMember(tx, organizationId, actorId);
      return tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: organizationSelect,
      });
    });
  }

  listMemberships(actorId: string, organizationId: string) {
    return this.transaction(async (tx) => {
      await this.lockActiveOrganization(tx, organizationId, 'shared');
      await this.requireMembershipManager(tx, organizationId, actorId);
      return tx.organizationMembership.findMany({
        where: { organizationId },
        select: membershipDirectorySelect,
        orderBy: membershipOrder,
      });
    });
  }

  getMembership(actorId: string, organizationId: string, membershipId: string) {
    return this.transaction(async (tx) => {
      await this.lockActiveOrganization(tx, organizationId, 'shared');
      await this.requireMembershipManager(tx, organizationId, actorId);
      return this.findMembership(tx, organizationId, membershipId);
    });
  }

  async createMembership(
    actorId: string,
    organizationId: string,
    userId: string,
  ) {
    try {
      return await this.transaction(async (tx) => {
        await this.lockActiveOrganization(tx, organizationId, 'exclusive');
        await this.requirePlatformAdmin(tx, actorId);
        const user = await tx.user.findUnique({
          where: { id: userId, status: 'ACTIVE', deletedAt: null },
          select: { id: true },
        });
        if (!user) throw new NotFoundException('Active user not found');

        // Stage 4 admissions are explicitly accepted by the Platform Admin.
        const now = new Date();
        const membership = await tx.organizationMembership.create({
          data: {
            organizationId,
            userId,
            addedById: actorId,
            joinedAt: now,
            acceptedAt: now,
            status: MembershipStatus.ACTIVE,
            permission: OrganizationPermission.MEMBER,
          },
          select: membershipSelect,
        });
        await this.audit(
          tx,
          actorId,
          organizationId,
          'ORGANIZATION_MEMBERSHIP_CREATED',
          { to: membership.status, permission: membership.permission },
          membership.id,
        );
        return membership;
      });
    } catch (error) {
      if (isUniqueConflict(error))
        throw new ConflictException('A current membership already exists');
      throw error;
    }
  }

  changeMembershipPermission(
    actorId: string,
    organizationId: string,
    membershipId: string,
    permission: OrganizationPermission,
  ) {
    return this.transaction(async (tx) => {
      await this.lockActiveOrganization(tx, organizationId, 'exclusive');
      await this.requirePlatformAdmin(tx, actorId);
      const membership = await this.findMembership(
        tx,
        organizationId,
        membershipId,
      );
      if (
        membership.status !== MembershipStatus.ACTIVE ||
        !membership.acceptedAt
      )
        throw new ConflictException(
          'An accepted active membership is required',
        );
      if (membership.permission === permission) return membership;

      const updated = await tx.organizationMembership.update({
        where: { id: membership.id },
        data: { permission },
        select: membershipDirectorySelect,
      });
      await this.audit(
        tx,
        actorId,
        organizationId,
        permission === OrganizationPermission.ORG_ADMIN
          ? 'ORGANIZATION_ADMIN_ASSIGNED'
          : 'ORGANIZATION_ADMIN_REVOKED',
        { from: membership.permission, to: permission },
        membership.id,
      );
      return updated;
    });
  }

  async membershipHistory(organizationId: string, membershipId: string) {
    await this.findMembership(this.prisma, organizationId, membershipId);
    return this.prisma.auditLog.findMany({
      where: {
        organizationId,
        targetId: membershipId,
        targetType: 'ORGANIZATION_MEMBERSHIP',
      },
      select: {
        id: true,
        actorUserId: true,
        action: true,
        targetId: true,
        organizationId: true,
        result: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  manageMembership(
    actorId: string,
    organizationId: string,
    membershipId: string,
    status: Exclude<MembershipEndStatus, 'LEFT'>,
    reason: string,
  ) {
    return this.transaction(async (tx) => {
      await this.lockActiveOrganization(tx, organizationId, 'exclusive');
      const platformAdmin = await this.requireMembershipManager(
        tx,
        organizationId,
        actorId,
      );
      const membership = await this.findMembership(
        tx,
        organizationId,
        membershipId,
      );
      if (
        !platformAdmin &&
        membership.permission === OrganizationPermission.ORG_ADMIN
      )
        throw new ForbiddenException(
          'Only Platform Admins can manage an Organization Admin membership',
        );
      const isCurrent =
        membership.status === MembershipStatus.ACTIVE ||
        (status === MembershipStatus.REMOVED &&
          membership.status === MembershipStatus.SUSPENDED);
      if (!isCurrent)
        throw new ConflictException('Membership cannot make this transition');

      return this.endMembership(tx, actorId, membership, status, reason);
    });
  }

  leave(actorId: string, organizationId: string) {
    return this.transaction(async (tx) => {
      await this.lockActiveOrganization(tx, organizationId, 'exclusive');
      const { id } = await requireActiveOrganizationMember(
        tx,
        organizationId,
        actorId,
      );
      const membership = await this.findMembership(tx, organizationId, id);
      return this.endMembership(tx, actorId, membership, MembershipStatus.LEFT);
    });
  }

  private async endMembership(
    tx: Prisma.TransactionClient,
    actorId: string,
    membership: {
      id: string;
      organizationId: string;
      userId: string;
      status: MembershipStatus;
    },
    status: MembershipEndStatus,
    reason?: string,
  ) {
    const now = new Date();
    const updated = await tx.organizationMembership.update({
      where: { id: membership.id },
      data: {
        status,
        ...(status === MembershipStatus.LEFT ? { leftAt: now } : {}),
        ...(status === MembershipStatus.REMOVED ? { removedAt: now } : {}),
      },
      select: membershipSelect,
    });
    const revocations = await revokeOrganizationGrants(
      tx,
      membership.organizationId,
      membership.userId,
    );
    await this.audit(
      tx,
      actorId,
      membership.organizationId,
      membershipActions[status],
      {
        from: membership.status,
        to: status,
        ...(reason && { reason }),
        ...revocations,
      },
      membership.id,
    );
    return updated;
  }

  private async findMembership(
    db: Pick<Prisma.TransactionClient, 'organizationMembership'>,
    organizationId: string,
    id: string,
  ) {
    const member = await db.organizationMembership.findUnique({
      where: { id, organizationId },
      select: membershipDirectorySelect,
    });
    if (!member)
      throw new NotFoundException('Organization membership not found');
    return member;
  }

  private async lockActiveOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    mode: 'shared' | 'exclusive',
  ) {
    const organization = await lockOrganization(tx, organizationId, mode);
    requireActiveOrganization(organization);
  }

  private async requireMembershipManager(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorId: string,
  ) {
    const platformAdmin = await this.isPlatformAdmin(tx, actorId);
    if (!platformAdmin)
      await requireActiveOrganizationMember(
        tx,
        organizationId,
        actorId,
        OrganizationPermission.ORG_ADMIN,
      );
    return platformAdmin;
  }

  private async isPlatformAdmin(tx: Prisma.TransactionClient, userId: string) {
    const admin = await tx.user.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        deletedAt: null,
        roleAssignments: {
          some: {
            revokedAt: null,
            role: { code: RoleCode.PLATFORM_ADMIN, deletedAt: null },
          },
        },
      },
      select: { id: true },
    });
    return Boolean(admin);
  }

  private async requirePlatformAdmin(
    tx: Prisma.TransactionClient,
    userId: string,
  ) {
    if (!(await this.isPlatformAdmin(tx, userId)))
      throw new ForbiddenException('Platform Admin role required');
  }

  private audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    organizationId: string,
    action: string,
    metadata: Prisma.InputJsonObject,
    membershipId?: string,
  ) {
    return tx.auditLog.create({
      data: {
        actorUserId,
        organizationId,
        action,
        targetId: membershipId ?? organizationId,
        targetType: membershipId ? 'ORGANIZATION_MEMBERSHIP' : 'ORGANIZATION',
        result: 'SUCCESS',
        metadata,
      },
    });
  }

  private transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
}
