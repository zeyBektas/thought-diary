import {
  databaseNow,
  hashEmailToken,
  isEmailToken,
  lockActiveEmailAccount,
  matchesEmailTokenHash,
  newEmailToken,
  normalizeEmail,
} from '@/core/mail/email-token';
import { deliver, MailDelivery } from '@/core/mail/mail-delivery.module';
import { PrismaService } from '@/core/prisma/prisma.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InvitationType, Prisma, RoleCode } from '@prisma/client';
import { lockEligibleCounselor } from '../counselors/counselor-eligibility';
import {
  isCurrentPlatformAdmin,
  lockOrganization,
  requireActiveOrganization,
  requireActiveOrganizationMember,
} from './organization-context';

const sevenDays = 7 * 24 * 60 * 60 * 1_000;
const invalidInvitation = () =>
  new BadRequestException('Invitation is not valid');
const publicInvitation = {
  id: true,
  organizationId: true,
  email: true,
  type: true,
  status: true,
  invitedById: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
} satisfies Prisma.OrganizationInvitationSelect;
type Invitation = Prisma.OrganizationInvitationGetPayload<{
  select: typeof publicInvitation;
}>;
type Target = Pick<Invitation, 'id' | 'organizationId'>;

@Injectable()
export class OrganizationInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailDelivery,
  ) {}

  async create(
    actorId: string,
    organizationId: string,
    address: string,
    type: InvitationType,
  ) {
    const email = normalizeEmail(address);
    return this.transaction(async (tx) => {
      await this.authorize(tx, actorId, organizationId);
      const invitedUserId =
        type === 'COUNSELOR' ? await this.counselorRecipient(tx, email) : null;
      const now = await databaseNow(tx);
      await this.expire(tx, actorId, organizationId, now);
      // The expression matches the existing migration-owned pending index.
      const [duplicate] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM organization_invitations
        WHERE "organizationId" = ${organizationId} AND lower(btrim(email)) = ${email}
          AND type = ${type}::"InvitationType" AND status = 'PENDING'
      `;
      if (duplicate)
        throw new ConflictException('A pending invitation already exists');

      const { token, tokenHash } = newEmailToken();
      const invitation = await tx.organizationInvitation.create({
        data: {
          organizationId,
          email,
          type,
          invitedUserId,
          invitedById: actorId,
          tokenHash,
          createdAt: now,
          expiresAt: new Date(now.getTime() + sevenDays),
        },
        select: publicInvitation,
      });
      await this.audit(
        tx,
        actorId,
        invitation,
        'ORGANIZATION_INVITATION_CREATED',
      );
      await this.send(tx, invitation, token);
      return invitation;
    });
  }

  list(actorId: string, organizationId: string) {
    return this.transaction(async (tx) => {
      await this.authorize(tx, actorId, organizationId, true);
      await this.expire(tx, actorId, organizationId, await databaseNow(tx));
      return tx.organizationInvitation.findMany({
        where: { organizationId },
        select: publicInvitation,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    });
  }

  inspect(actorId: string, organizationId: string, id: string) {
    return this.transaction(async (tx) => {
      await this.authorize(tx, actorId, organizationId, true);
      await this.expire(tx, actorId, organizationId, await databaseNow(tx), id);
      return this.findScoped(tx, organizationId, id);
    });
  }

  async change(
    actorId: string,
    organizationId: string,
    id: string,
    action: 'resend' | 'revoke',
  ) {
    const result = await this.transaction(async (tx) => {
      await this.authorize(tx, actorId, organizationId, action === 'revoke');
      const now = await databaseNow(tx);
      if (await this.expire(tx, actorId, organizationId, now, id)) return null;
      const current = await this.findScoped(tx, organizationId, id);
      if (current.status !== 'PENDING') return null;
      if (action === 'revoke') {
        const revoked = await tx.organizationInvitation.update({
          where: { id },
          data: { status: 'REVOKED', revokedAt: now },
          select: publicInvitation,
        });
        await this.audit(
          tx,
          actorId,
          current,
          'ORGANIZATION_INVITATION_REVOKED',
        );
        return revoked;
      }

      if (current.type === 'COUNSELOR') {
        const recipient = await this.counselorRecipient(
          tx,
          normalizeEmail(current.email),
        );
        const binding = await tx.organizationInvitation.findUniqueOrThrow({
          where: { id },
          select: { invitedUserId: true },
        });
        if (binding.invitedUserId !== recipient)
          throw new ConflictException(
            'Recipient is not an eligible verified counselor',
          );
      }
      if (
        await this.expire(
          tx,
          actorId,
          organizationId,
          await databaseNow(tx),
          id,
        )
      )
        return null;
      const { token, tokenHash } = newEmailToken();
      const updated = await tx.organizationInvitation.update({
        where: { id },
        data: { tokenHash },
        select: publicInvitation,
      });
      await this.audit(tx, actorId, current, 'ORGANIZATION_INVITATION_RESENT');
      await this.send(tx, updated, token);
      return updated;
    });
    if (!result)
      throw new ConflictException('Invitation is not pending and unexpired');
    return result;
  }

  async accept(userId: string, token: string) {
    if (!isEmailToken(token)) throw invalidInvitation();
    const tokenHash = hashEmailToken(token);
    // This lookup is only a lock-routing hint, not authorization.
    const hint = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash },
      select: { id: true, organizationId: true },
    });
    if (!hint) throw invalidInvitation();

    const result = await this.transaction(async (tx) => {
      // Same lock order as Stage 4: organization first. This serializes
      // invitation mutations with suspension and membership lifecycle writes.
      const [org] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM organizations WHERE id = ${hint.organizationId}
          AND status = 'ACTIVE' AND "deletedAt" IS NULL FOR UPDATE
      `;
      if (!org) return null;
      await tx.$queryRaw`SELECT id FROM organization_invitations WHERE id = ${hint.id} FOR UPDATE`;
      const invitation = await tx.organizationInvitation.findUnique({
        where: { id: hint.id, organizationId: org.id },
      });
      if (
        !invitation ||
        invitation.status !== 'PENDING' ||
        !matchesEmailTokenHash(tokenHash, invitation.tokenHash)
      )
        return null;

      const account = await lockActiveEmailAccount(tx, userId);
      const now = await databaseNow(tx);
      if (await this.expire(tx, userId, org.id, now, invitation.id))
        return null;
      if (
        !account?.emailVerifiedAt ||
        normalizeEmail(account.email) !== normalizeEmail(invitation.email) ||
        (invitation.invitedUserId !== null &&
          invitation.invitedUserId !== userId) ||
        (await this.uniqueEmailAccountId(
          tx,
          normalizeEmail(invitation.email),
        )) !== userId
      ) {
        // Attribute only attempts using a known, current secret; never store
        // either address or why the recipient identity did not qualify.
        await this.audit(
          tx,
          userId,
          invitation,
          'ORGANIZATION_INVITATION_ACCEPTANCE_DENIED',
          'DENIED',
        );
        return null;
      }
      if (invitation.type === 'COUNSELOR') {
        if (
          invitation.invitedUserId !== userId ||
          !(await this.isEligibleCounselor(tx, userId))
        ) {
          await this.audit(
            tx,
            userId,
            invitation,
            'ORGANIZATION_INVITATION_ACCEPTANCE_DENIED',
            'DENIED',
          );
          return null;
        }
      }

      const current = await tx.organizationMembership.findFirst({
        where: {
          organizationId: org.id,
          userId,
          status: { in: ['ACTIVE', 'SUSPENDED'] },
        },
        select: { id: true },
      });
      const acceptedAt = await databaseNow(tx);
      if (await this.expire(tx, userId, org.id, acceptedAt, invitation.id))
        return null;
      if (current) return { alreadyMember: true } as const;
      if (invitation.type === 'CLIENT') await this.ensureClientRole(tx, userId);

      const membership = await tx.organizationMembership.create({
        data: {
          organizationId: org.id,
          userId,
          joinedAt: acceptedAt,
          acceptedAt,
          addedById: invitation.invitedById,
          status: 'ACTIVE',
          permission: 'MEMBER',
        },
        select: {
          id: true,
          organizationId: true,
          status: true,
          permission: true,
          acceptedAt: true,
        },
      });
      await tx.organizationInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt, invitedUserId: userId },
      });
      await this.audit(
        tx,
        userId,
        invitation,
        'ORGANIZATION_INVITATION_ACCEPTED',
        'SUCCESS',
        { membershipId: membership.id },
      );
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          organizationId: org.id,
          targetId: membership.id,
          action: 'ORGANIZATION_MEMBERSHIP_CREATED',
          targetType: 'ORGANIZATION_MEMBERSHIP',
          result: 'SUCCESS',
          metadata: { invitationId: invitation.id, permission: 'MEMBER' },
        },
      });
      return { membership };
    });
    if (!result) throw invalidInvitation();
    if ('alreadyMember' in result)
      throw new ConflictException(
        'A current organization membership already exists',
      );
    return result;
  }

  private async authorize(
    tx: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    allowSuspendedForPlatform = false,
  ) {
    const organization = await lockOrganization(
      tx,
      organizationId,
      'exclusive',
    );
    const platformAdmin = await isCurrentPlatformAdmin(tx, actorId);
    if (!platformAdmin || !allowSuspendedForPlatform)
      requireActiveOrganization(organization);
    if (!platformAdmin)
      await requireActiveOrganizationMember(
        tx,
        organizationId,
        actorId,
        'ORG_ADMIN',
      );
  }

  private async counselorRecipient(
    tx: Prisma.TransactionClient,
    email: string,
  ) {
    const userId = await this.uniqueEmailAccountId(tx, email);
    const account = userId
      ? await lockActiveEmailAccount(tx, userId)
      : undefined;
    if (
      !account ||
      !account.emailVerifiedAt ||
      normalizeEmail(account.email) !== email ||
      !(await this.isEligibleCounselor(tx, account.id))
    )
      throw new ConflictException(
        'Recipient is not an eligible verified counselor',
      );
    return account.id;
  }

  private async uniqueEmailAccountId(
    tx: Prisma.TransactionClient,
    email: string,
  ) {
    // Keep legacy rows intact and fail closed on ambiguous normalized emails.
    const candidates = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE lower(btrim(email)) = ${email} LIMIT 2
    `;
    return candidates.length === 1 ? candidates[0].id : undefined;
  }

  private async isEligibleCounselor(
    tx: Prisma.TransactionClient,
    userId: string,
  ) {
    try {
      await lockEligibleCounselor(tx, userId);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  private async ensureClientRole(tx: Prisma.TransactionClient, userId: string) {
    const role = await tx.role.findUnique({
      where: { code: RoleCode.CLIENT, deletedAt: null },
    });
    if (!role)
      throw new InternalServerErrorException('CLIENT role is not configured');
    // The active-assignment partial index is authoritative; revoked history
    // and the legacy User.roleId remain untouched.
    await tx.userRole.createMany({
      data: [{ userId, roleId: role.id }],
      skipDuplicates: true,
    });
  }

  private async findScoped(
    tx: Prisma.TransactionClient,
    organizationId: string,
    id: string,
  ) {
    const invitation = await tx.organizationInvitation.findUnique({
      where: { id, organizationId },
      select: publicInvitation,
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    return invitation;
  }

  private async expire(
    tx: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    now: Date,
    id?: string,
  ) {
    const expired = await tx.organizationInvitation.updateManyAndReturn({
      where: { id, organizationId, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
      select: { id: true, organizationId: true },
    });
    for (const invitation of expired)
      await this.audit(
        tx,
        actorId,
        invitation,
        'ORGANIZATION_INVITATION_EXPIRED',
      );
    return expired.length;
  }

  private async send(
    tx: Prisma.TransactionClient,
    invitation: Invitation,
    token: string,
  ) {
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: invitation.organizationId },
      select: { name: true },
    });
    await deliver(this.mail, {
      purpose: 'ORGANIZATION_INVITATION',
      to: invitation.email,
      token,
      organizationName: organization.name,
      invitationType: invitation.type,
      expiresAt: invitation.expiresAt,
    });
  }

  private audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    target: Target,
    action: string,
    result: 'SUCCESS' | 'DENIED' = 'SUCCESS',
    metadata?: Prisma.InputJsonObject,
  ) {
    return tx.auditLog.create({
      data: {
        actorUserId,
        organizationId: target.organizationId,
        action,
        targetId: target.id,
        targetType: 'ORGANIZATION_INVITATION',
        result,
        metadata,
      },
    });
  }

  private transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10_000,
    });
  }
}
