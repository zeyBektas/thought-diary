import { PrismaService } from '@/core/prisma/prisma.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CounselorApprovalStatus, Prisma, RoleCode } from '@prisma/client';
import { revokeCounselorGrants } from '../diaries/counselor-share-revocation';
import type { CounselorProfileDto } from './dto/counselor-profile.dto';

const { PENDING, APPROVED, REJECTED, SUSPENDED } = CounselorApprovalStatus;

const counselorRole = {
  revokedAt: null,
  role: { code: RoleCode.COUNSELOR, deletedAt: null },
} satisfies Prisma.UserRoleWhereInput;

const applicantSelect = {
  id: true,
  userId: true,
  professionalTitle: true,
  biography: true,
  approvalStatus: true,
  rejectionReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CounselorProfileSelect;

const adminSelect = {
  ...applicantSelect,
  approvedById: true,
  approvedAt: true,
  rejectedById: true,
  rejectedAt: true,
  suspendedById: true,
  suspendedAt: true,
  user: {
    select: {
      firstName: true,
      lastName: true,
      username: true,
      status: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.CounselorProfileSelect;

const decisions = {
  approve: { from: PENDING, to: APPROVED, event: 'COUNSELOR_APPROVED' },
  reject: { from: PENDING, to: REJECTED, event: 'COUNSELOR_REJECTED' },
  suspend: { from: APPROVED, to: SUSPENDED, event: 'COUNSELOR_SUSPENDED' },
  reinstate: { from: SUSPENDED, to: APPROVED, event: 'COUNSELOR_REINSTATED' },
} as const;

type Decision =
  | { kind: 'approve' }
  | { kind: 'reject' | 'suspend' | 'reinstate'; reason: string };

type LockedProfile = {
  id: string;
  userId: string;
  approvalStatus: CounselorApprovalStatus;
};

type ApplicantProfile = Prisma.CounselorProfileGetPayload<{
  select: typeof applicantSelect;
}>;

const targetType = 'COUNSELOR_PROFILE';
const applicationNotFound = 'Counselor application not found';

function selfProfile({ rejectionReason, ...profile }: ApplicantProfile) {
  return profile.approvalStatus === REJECTED
    ? { ...profile, rejectionReason }
    : profile;
}

function professionalFields({
  professionalTitle,
  biography,
}: CounselorProfileDto) {
  return {
    ...(professionalTitle !== undefined && { professionalTitle }),
    ...(biography !== undefined && { biography }),
  };
}

@Injectable()
export class CounselorProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(userId: string, dto: CounselorProfileDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockApplicant(tx, userId);
      if (
        await tx.counselorProfile.findUnique({
          where: { userId },
          select: { id: true },
        })
      ) {
        throw new ConflictException('Counselor application already exists');
      }

      const role = await tx.role.findUnique({
        where: { code: RoleCode.COUNSELOR, deletedAt: null },
        select: { id: true },
      });
      if (!role) {
        throw new InternalServerErrorException(
          'COUNSELOR role is not configured',
        );
      }

      const assignment = await tx.userRole.findFirst({
        where: { userId, roleId: role.id, revokedAt: null },
        select: { id: true },
      });
      if (!assignment) {
        const previousAssignment = await tx.userRole.findFirst({
          where: { userId, roleId: role.id },
          select: { id: true },
        });
        if (previousAssignment) {
          throw new ForbiddenException(
            'A revoked counselor role requires review',
          );
        }
        await tx.userRole.create({
          data: { userId, roleId: role.id, assignedById: userId },
        });
      }

      const profile = await tx.counselorProfile.create({
        data: { userId, ...professionalFields(dto), approvalStatus: PENDING },
        select: applicantSelect,
      });

      await this.audit(
        tx,
        userId,
        profile.id,
        'COUNSELOR_APPLICATION_SUBMITTED',
        {
          to: PENDING,
        },
      );
      return selfProfile(profile);
    });
  }

  async findMine(userId: string) {
    const profile = await this.prisma.counselorProfile.findUnique({
      where: { userId },
      select: applicantSelect,
    });
    if (!profile) throw new NotFoundException(applicationNotFound);
    return selfProfile(profile);
  }

  async updateMine(userId: string, dto: CounselorProfileDto) {
    const fields = professionalFields(dto);
    const changedFields = Object.keys(fields);
    if (!changedFields.length) {
      throw new BadRequestException('Provide at least one professional field');
    }

    return this.prisma.$transaction(async (tx) => {
      const profile = await this.lockApplicantProfile(tx, userId);
      if (
        profile.approvalStatus !== PENDING &&
        profile.approvalStatus !== APPROVED
      ) {
        throw new ConflictException(
          'Only pending and approved profiles can be edited',
        );
      }

      const updated = await tx.counselorProfile.update({
        where: { id: profile.id },
        data: fields,
        select: applicantSelect,
      });
      await this.audit(tx, userId, profile.id, 'COUNSELOR_PROFILE_UPDATED', {
        changedFields,
      });
      return selfProfile(updated);
    });
  }

  async resubmit(userId: string, dto: CounselorProfileDto) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await this.lockApplicantProfile(tx, userId);
      if (profile.approvalStatus !== REJECTED) {
        throw new ConflictException(
          'Only rejected applications can be resubmitted',
        );
      }
      await this.requireCounselorRole(tx, userId);

      const fields = professionalFields(dto);
      const updated = await tx.counselorProfile.update({
        where: { id: profile.id },
        data: { ...fields, approvalStatus: PENDING },
        select: applicantSelect,
      });
      await this.audit(
        tx,
        userId,
        profile.id,
        'COUNSELOR_APPLICATION_RESUBMITTED',
        {
          from: REJECTED,
          to: PENDING,
          changedFields: Object.keys(fields),
        },
      );
      return selfProfile(updated);
    });
  }

  listForReview() {
    return this.prisma.counselorProfile.findMany({
      select: adminSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async findForReview(id: string) {
    const profile = await this.prisma.counselorProfile.findUnique({
      where: { id },
      select: adminSelect,
    });
    if (!profile) throw new NotFoundException(applicationNotFound);
    return profile;
  }

  async history(id: string) {
    const profile = await this.prisma.counselorProfile.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException(applicationNotFound);
    return this.prisma.auditLog.findMany({
      where: { targetType, targetId: id },
      select: {
        id: true,
        actorUserId: true,
        action: true,
        result: true,
        metadata: true,
        correlationId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async decide(actorUserId: string, id: string, decision: Decision) {
    const { from, to, event } = decisions[decision.kind];
    return this.prisma.$transaction(
      async (tx) => {
        const [profile] = await tx.$queryRaw<LockedProfile[]>`
        SELECT id, "userId", "approvalStatus"
        FROM counselor_profiles WHERE id = ${id} FOR UPDATE`;
        await this.requirePlatformAdmin(tx, actorUserId);
        if (!profile) throw new NotFoundException(applicationNotFound);
        if (profile.userId === actorUserId) {
          throw new ForbiddenException(
            'Counselors cannot review their own applications',
          );
        }
        if (profile.approvalStatus !== from) {
          throw new ConflictException(
            `Counselor profile must be ${from} for this action`,
          );
        }
        if (to === APPROVED) {
          await this.requireCounselorRole(tx, profile.userId);
        }

        const now = new Date();
        const data: Prisma.CounselorProfileUncheckedUpdateInput = {
          approvalStatus: to,
        };
        if (to === APPROVED) {
          data.approvedById = actorUserId;
          data.approvedAt = now;
        } else if (decision.kind === 'reject') {
          data.rejectedById = actorUserId;
          data.rejectedAt = now;
          data.rejectionReason = decision.reason;
        } else if (to === SUSPENDED) {
          data.suspendedById = actorUserId;
          data.suspendedAt = now;
        }
        const updated = await tx.counselorProfile.update({
          where: { id },
          data,
          select: adminSelect,
        });

        const metadata: Prisma.InputJsonObject = {
          from,
          to,
          ...('reason' in decision && { reason: decision.reason }),
          ...(to === SUSPENDED && {
            revokedGrantCount: await revokeCounselorGrants(tx, profile.userId),
          }),
        };
        await this.audit(tx, actorUserId, id, event, metadata);
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async lockApplicant(tx: Prisma.TransactionClient, userId: string) {
    // Serialize self-service writes with account status changes and other applications.
    const [user] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users
      WHERE id = ${userId} AND status = 'ACTIVE' AND "deletedAt" IS NULL
      FOR NO KEY UPDATE`;
    if (!user) throw new UnauthorizedException('User is not active');
  }

  private async lockApplicantProfile(
    tx: Prisma.TransactionClient,
    userId: string,
  ) {
    await this.lockApplicant(tx, userId);
    const [profile] = await tx.$queryRaw<LockedProfile[]>`
      SELECT id, "userId", "approvalStatus"
      FROM counselor_profiles WHERE "userId" = ${userId} FOR UPDATE`;
    if (!profile) throw new NotFoundException(applicationNotFound);
    return profile;
  }

  private async requireCounselorRole(
    tx: Prisma.TransactionClient,
    userId: string,
  ) {
    const user = await tx.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        roleAssignments: { some: counselorRole },
      },
      select: { id: true },
    });
    if (!user) {
      throw new ConflictException('A current counselor role is required');
    }
  }

  private async requirePlatformAdmin(
    tx: Prisma.TransactionClient,
    userId: string,
  ) {
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
    if (!admin) throw new ForbiddenException('Platform Admin role required');
  }

  private audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    targetId: string,
    action: string,
    metadata: Prisma.InputJsonObject,
  ) {
    return tx.auditLog.create({
      data: {
        actorUserId,
        targetType,
        targetId,
        action,
        result: 'SUCCESS',
        metadata,
      },
    });
  }
}
