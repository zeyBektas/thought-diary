import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

describe('isolated organization foundation migration', () => {
  let app: INestApplication;
  let db: PrismaService;
  let userId: string;
  let otherId: string;
  let roleId: string;
  let organizationId: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    db = app.get(PrismaService);
    const role = await db.role.upsert({
      where: { code: 'CLIENT' },
      create: { code: 'CLIENT' },
      update: {},
    });
    roleId = role.id;
    const makeUser = () =>
      db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          passwordHash: 'fixture',
          firstName: 'Synthetic',
          lastName: 'User',
          roleId,
        },
      });
    [userId, otherId] = (await Promise.all([makeUser(), makeUser()])).map(
      (user) => user.id,
    );
    organizationId = (
      await db.organization.create({ data: { name: randomUUID() } })
    ).id;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('replays the migration with expected enums, tables, columns and defaults', async () => {
    const enums = await db.$queryRaw<Array<{ name: string; values: string[] }>>`
      SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname IN ('RoleCode', 'CounselorApprovalStatus', 'OrganizationStatus', 'MembershipStatus', 'OrganizationPermission', 'InvitationType', 'InvitationStatus')
      GROUP BY t.typname`;
    expect(
      Object.fromEntries(enums.map(({ name, values }) => [name, values])),
    ).toEqual({
      RoleCode: ['ADMIN', 'CLIENT', 'COUNSELOR', 'PLATFORM_ADMIN'],
      CounselorApprovalStatus: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'],
      OrganizationStatus: ['ACTIVE', 'SUSPENDED'],
      MembershipStatus: ['ACTIVE', 'SUSPENDED', 'LEFT', 'REMOVED'],
      OrganizationPermission: ['MEMBER', 'ORG_ADMIN'],
      InvitationType: ['CLIENT', 'COUNSELOR'],
      InvitationStatus: [
        'PENDING',
        'ACCEPTED',
        'DECLINED',
        'EXPIRED',
        'REVOKED',
      ],
    });
    const tables = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name IN ('user_roles', 'counselor_profiles', 'organization_memberships', 'organization_invitations', 'audit_logs')`;
    expect(tables).toHaveLength(5);
    const columns = await db.$queryRaw<
      Array<{ table_name: string; column_name: string; is_nullable: string }>
    >`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'
      AND ((table_name = 'care_relationships' AND column_name = 'organizationId') OR
        (table_name = 'organizations' AND column_name IN ('status', 'suspendedAt', 'suspendedById', 'suspensionReason', 'reactivatedAt')))`;
    expect(columns).toHaveLength(6);
    expect(columns).toContainEqual({
      table_name: 'care_relationships',
      column_name: 'organizationId',
      is_nullable: 'YES',
    });
    expect(
      (
        await db.organization.findUniqueOrThrow({
          where: { id: organizationId },
        })
      ).status,
    ).toBe('ACTIVE');
  });

  it('preserves the definitions of all custom partial indexes', async () => {
    const indexes = await db.$queryRaw<
      Array<{
        name: string;
        definition: string;
        predicate: string;
        valid: boolean;
        unique: boolean;
      }>
    >`
      SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
        pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indisvalid AS valid, i.indisunique AS "unique"
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (
        'user_roles_active_user_role_key', 'organization_memberships_current_pair_key',
        'organization_invitations_pending_key', 'care_relationships_non_revoked_independent_pair_key',
        'care_relationships_non_revoked_organization_pair_key'
      )`;
    expect(indexes).toHaveLength(5);
    for (const index of indexes)
      expect(index).toMatchObject({ valid: true, unique: true });
    const byName = Object.fromEntries(
      indexes.map((index) => [index.name, index]),
    );
    expect(byName.user_roles_active_user_role_key.definition).toContain(
      '("userId", "roleId")',
    );
    expect(byName.user_roles_active_user_role_key.predicate).toBe(
      '("revokedAt" IS NULL)',
    );
    expect(
      byName.organization_memberships_current_pair_key.definition,
    ).toContain('("organizationId", "userId")');
    expect(byName.organization_memberships_current_pair_key.predicate).toMatch(
      /ACTIVE.*SUSPENDED/,
    );
    expect(byName.organization_invitations_pending_key.definition).toContain(
      '("organizationId", lower(btrim(email)), type)',
    );
    expect(byName.organization_invitations_pending_key.predicate).toMatch(
      /PENDING/,
    );
    expect(
      byName.care_relationships_non_revoked_independent_pair_key.predicate,
    ).toMatch(/"organizationId" IS NULL.*<> 'REVOKED'/);
    expect(
      byName.care_relationships_non_revoked_organization_pair_key.predicate,
    ).toMatch(/"organizationId" IS NOT NULL.*<> 'REVOKED'/);
  });

  it('allows revoked role history but rejects duplicate active assignments', async () => {
    const data = { userId, roleId };
    const first = await db.userRole.create({ data });
    await expect(db.userRole.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    });
    await db.userRole.update({
      where: { id: first.id },
      data: { revokedAt: new Date() },
    });
    await db.userRole.create({ data });
    expect(await db.userRole.count({ where: data })).toBe(2);
  });

  it('retains historical memberships while ACTIVE and SUSPENDED block duplicates', async () => {
    const data = { userId, organizationId };
    const first = await db.organizationMembership.create({ data });
    await expect(
      db.organizationMembership.create({ data }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await db.organizationMembership.update({
      where: { id: first.id },
      data: { status: 'SUSPENDED' },
    });
    await expect(
      db.organizationMembership.create({ data }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await db.organizationMembership.update({
      where: { id: first.id },
      data: { status: 'LEFT' },
    });
    const second = await db.organizationMembership.create({ data });
    await db.organizationMembership.update({
      where: { id: second.id },
      data: { status: 'REMOVED' },
    });
    await db.organizationMembership.create({ data });
    expect(await db.organizationMembership.count({ where: data })).toBe(3);
  });

  it('enforces unique pending invitations by normalized email and unique token hashes', async () => {
    const data = {
      organizationId,
      email: ' Person@Example.test ',
      type: 'CLIENT' as const,
      tokenHash: randomUUID(),
      invitedById: userId,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const invitation = await db.organizationInvitation.create({ data });
    await expect(
      db.organizationInvitation.create({
        data: {
          ...data,
          email: 'person@example.test',
          tokenHash: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.organizationInvitation.create({
        data: { ...data, email: 'other@example.test' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await db.organizationInvitation.update({
      where: { id: invitation.id },
      data: { status: 'REVOKED' },
    });
    await db.organizationInvitation.create({
      data: { ...data, tokenHash: randomUUID() },
    });
  });

  it('enforces foreign keys, profile uniqueness, immutable provenance and audit retention', async () => {
    await expect(
      db.counselorProfile.create({ data: { userId: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    const profile = await db.counselorProfile.create({ data: { userId } });
    expect(profile.approvalStatus).toBe('PENDING');
    await expect(
      db.counselorProfile.create({ data: { userId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const relationship = await db.careRelationship.create({
      data: { clientId: userId, counselorId: otherId },
    });
    expect(relationship.organizationId).toBeNull();
    await expect(
      db.careRelationship.update({
        where: { id: relationship.id },
        data: { organizationId },
      }),
    ).rejects.toThrow();
    const organizational = await db.careRelationship.create({
      data: { clientId: otherId, counselorId: userId, organizationId },
    });
    expect(organizational.organizationId).toBe(organizationId);
    await db.auditLog.create({
      data: {
        actorUserId: userId,
        organizationId,
        action: 'TEST',
        targetType: 'fixture',
        targetId: randomUUID(),
        result: 'SUCCESS',
      },
    });
    const constraints = await db.$queryRaw<
      Array<{ name: string; delete_action: string }>
    >`
      SELECT conname AS name, confdeltype::text AS delete_action FROM pg_constraint
      WHERE conname IN ('audit_logs_actorUserId_fkey', 'audit_logs_organizationId_fkey')`;
    expect(constraints).toHaveLength(2);
    expect(
      constraints.every((constraint) => constraint.delete_action === 'r'),
    ).toBe(true);
    await expect(
      db.auditLog.create({
        data: {
          actorUserId: randomUUID(),
          action: 'TEST',
          targetType: 'fixture',
          targetId: randomUUID(),
          result: 'SUCCESS',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('prevents hard deletion of audit actors and organizations while preserving soft-deleted records', async () => {
    const actor = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'fixture',
        firstName: 'Audit',
        lastName: 'Actor',
        roleId,
      },
    });
    const organization = await db.organization.create({
      data: { name: randomUUID() },
    });
    const audit = await db.auditLog.create({
      data: {
        actorUserId: actor.id,
        organizationId: organization.id,
        action: 'TEST',
        targetType: 'fixture',
        targetId: randomUUID(),
        result: 'SUCCESS',
      },
    });
    await expect(
      db.user.delete({ where: { id: actor.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      db.organization.delete({ where: { id: organization.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await db.user.update({
      where: { id: actor.id },
      data: { deletedAt: new Date() },
    });
    await db.organization.update({
      where: { id: organization.id },
      data: { deletedAt: new Date() },
    });
    expect(
      await db.auditLog.findUnique({ where: { id: audit.id } }),
    ).toMatchObject({ actorUserId: actor.id, organizationId: organization.id });
  });
});
