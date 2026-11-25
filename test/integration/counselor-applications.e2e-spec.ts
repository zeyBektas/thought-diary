import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { CounselorApprovalStatus, RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

type ProfileResponse = { id: string; approvalStatus: CounselorApprovalStatus };
type AuditEvent = { action: string; actorUserId: string; metadata: unknown };

describe('isolated counselor application and review', () => {
  let app: INestApplication;
  let db: PrismaService;
  const roleIds = new Map<RoleCode, string>();
  const server = () => app.getHttpServer() as Server;
  const auth = (token: string) => `Bearer ${token}`;
  const applications = '/counselor-applications';
  const mine = `${applications}/me`;
  const review = '/admin/counselors';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    db = app.get(PrismaService);
    for (const code of Object.values(RoleCode)) {
      const role = await db.role.upsert({
        where: { code },
        update: {},
        create: { code },
      });
      roleIds.set(code, role.id);
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function account(code: RoleCode = RoleCode.CLIENT, claim?: RoleCode) {
    const roleId = roleIds.get(code)!;
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'synthetic-unused',
        firstName: 'Synthetic',
        lastName: 'Account',
        roleId,
        roleAssignments: { create: { roleId } },
      },
      select: { id: true, roleId: true },
    });
    const token = app.get(JwtService).sign({ sub: user.id, role: claim });
    return { ...user, token };
  }

  const get = (token: string, path: string) =>
    request(server()).get(path).set('Authorization', auth(token));

  const post = (token: string, path: string, body: object = {}) =>
    request(server()).post(path).set('Authorization', auth(token)).send(body);

  const patch = (token: string, body: object) =>
    request(server()).patch(mine).set('Authorization', auth(token)).send(body);

  async function apply(token: string) {
    const response = await post(token, applications, {
      professionalTitle: '  Counselor in training  ',
      biography: '  Supervised practice  ',
    }).expect(201);
    return response.body as ProfileResponse;
  }

  it('requires authentication, creates a pending application, and gives its owner only the permitted fields', async () => {
    const applicant = await account();
    const other = await account();

    await request(server()).post(applications).send({}).expect(401);
    await get(applicant.token, mine).expect(404);
    const profile = await apply(applicant.token);
    const own = await get(applicant.token, mine).expect(200);
    expect(own.body).toEqual({
      id: profile.id,
      userId: applicant.id,
      approvalStatus: 'PENDING',
      professionalTitle: 'Counselor in training',
      biography: 'Supervised practice',
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
    await get(other.token, mine).expect(404);
    await get(other.token, `${review}/${profile.id}`).expect(403);
    await get(applicant.token, '/counselor/diaries').expect(403);

    const user = await db.user.findUniqueOrThrow({
      where: { id: applicant.id },
      select: {
        roleId: true,
        roleAssignments: { select: { role: { select: { code: true } } } },
      },
    });
    expect(user.roleId).toBe(applicant.roleId);
    expect(user.roleAssignments.map(({ role }) => role.code).sort()).toEqual([
      RoleCode.CLIENT,
      RoleCode.COUNSELOR,
    ]);

    const edited = await patch(applicant.token, {
      professionalTitle: '  Associate counselor  ',
      biography: '  First line\r\nSecond line  ',
    }).expect(200);
    expect(edited.body).toMatchObject({
      approvalStatus: 'PENDING',
      professionalTitle: 'Associate counselor',
      biography: 'First line\nSecond line',
    });
  });

  it('rejects invalid professional text and applicant-supplied decision fields', async () => {
    const applicant = await account();
    for (const body of [
      { professionalTitle: '   ' },
      { professionalTitle: 'x'.repeat(121) },
      { biography: '<b>title</b>' },
      { biography: 42 },
      { approvalStatus: 'APPROVED' },
      { approvedById: applicant.id },
      { rejectedById: applicant.id },
    ]) {
      await post(applicant.token, applications, body).expect(400);
    }
    const profile = await apply(applicant.token);
    await patch(applicant.token, {}).expect(400);
    for (const field of [
      'userId',
      'approvalStatus',
      'approvedById',
      'approvedAt',
      'rejectedById',
      'rejectedAt',
      'rejectionReason',
      'suspendedById',
      'suspendedAt',
    ]) {
      await patch(applicant.token, { [field]: 'invalid' }).expect(400);
    }
    expect((await get(applicant.token, mine).expect(200)).body).toMatchObject({
      id: profile.id,
      approvalStatus: 'PENDING',
    });
  });

  it('accepts an existing counselor role without duplicating it and prevents concurrent duplicate applications', async () => {
    const applicant = await account(RoleCode.COUNSELOR);
    const responses = await Promise.all([
      post(applicant.token, applications, { professionalTitle: 'Counselor' }),
      post(applicant.token, applications, { professionalTitle: 'Counselor' }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const profile = await db.counselorProfile.findUniqueOrThrow({
      where: { userId: applicant.id },
    });
    expect(profile.approvalStatus).toBe('PENDING');
    expect(await db.userRole.count({ where: { userId: applicant.id } })).toBe(
      1,
    );
    expect(
      await db.auditLog.count({
        where: {
          targetId: profile.id,
          action: 'COUNSELOR_APPLICATION_SUBMITTED',
        },
      }),
    ).toBe(1);
  });

  it('does not reassign a revoked counselor role through self-application', async () => {
    const applicant = await account(RoleCode.COUNSELOR);
    const revokedAt = new Date();
    await db.userRole.updateMany({
      where: { userId: applicant.id },
      data: { revokedAt },
    });
    await post(applicant.token, applications).expect(403);
    expect(
      await db.counselorProfile.findUnique({ where: { userId: applicant.id } }),
    ).toBeNull();
    expect(
      await db.userRole.findMany({
        where: { userId: applicant.id },
        select: { revokedAt: true },
      }),
    ).toEqual([{ revokedAt }]);
  });

  it('lets Platform Admins review, reject, and approve after resubmission while preserving history', async () => {
    const admin = await account(RoleCode.PLATFORM_ADMIN);
    const applicant = await account();
    const profile = await apply(applicant.token);
    const idPath = `${review}/${profile.id}`;
    const list = await get(admin.token, review).expect(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: profile.id,
          userId: applicant.id,
          approvalStatus: 'PENDING',
        }),
      ]),
    );
    const inspected = await get(admin.token, idPath).expect(200);
    expect(inspected.body).toMatchObject({
      id: profile.id,
      professionalTitle: 'Counselor in training',
    });
    expect(inspected.body).not.toHaveProperty('user.passwordHash');

    await post(admin.token, `${idPath}/reject`, { reason: '   ' }).expect(400);
    const rejected = await post(admin.token, `${idPath}/reject`, {
      reason: ' Additional supervision details required ',
    }).expect(200);
    expect(rejected.body).toMatchObject({
      approvalStatus: 'REJECTED',
      rejectionReason: 'Additional supervision details required',
      rejectedById: admin.id,
    });
    const own = await get(applicant.token, mine).expect(200);
    expect(own.body).toMatchObject({
      approvalStatus: 'REJECTED',
      rejectionReason: 'Additional supervision details required',
    });
    expect(own.body).not.toHaveProperty('rejectedById');
    expect(own.body).not.toHaveProperty('rejectedAt');
    await patch(applicant.token, { professionalTitle: 'Updated' }).expect(409);
    await post(admin.token, `${idPath}/approve`).expect(409);

    const resubmitted = await post(applicant.token, `${mine}/resubmit`, {
      biography: 'Completed supervised training',
    }).expect(200);
    expect(resubmitted.body).toMatchObject({
      id: profile.id,
      approvalStatus: 'PENDING',
    });
    expect(resubmitted.body).not.toHaveProperty('rejectionReason');
    const pending = await db.counselorProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(pending).toMatchObject({
      rejectedById: admin.id,
      rejectedAt: expect.any(Date) as Date,
      rejectionReason: 'Additional supervision details required',
    });

    const approved = await post(admin.token, `${idPath}/approve`).expect(200);
    expect(approved.body).toMatchObject({
      approvalStatus: 'APPROVED',
      approvedById: admin.id,
    });
    await get(applicant.token, '/counselor/diaries').expect(200);
    await post(admin.token, `${idPath}/approve`).expect(409);
    await patch(applicant.token, {
      professionalTitle: 'Associate counselor',
    }).expect(200);
    await post(applicant.token, `${mine}/resubmit`).expect(409);

    const history = await get(admin.token, `${idPath}/history`).expect(200);
    const events = history.body as AuditEvent[];
    expect(events).toHaveLength(5);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'COUNSELOR_APPLICATION_SUBMITTED',
          actorUserId: applicant.id,
        }),
        expect.objectContaining({
          action: 'COUNSELOR_REJECTED',
          actorUserId: admin.id,
          metadata: {
            from: 'PENDING',
            to: 'REJECTED',
            reason: 'Additional supervision details required',
          },
        }),
        expect.objectContaining({
          action: 'COUNSELOR_APPLICATION_RESUBMITTED',
          actorUserId: applicant.id,
        }),
        expect.objectContaining({
          action: 'COUNSELOR_APPROVED',
          actorUserId: admin.id,
        }),
        expect.objectContaining({
          action: 'COUNSELOR_PROFILE_UPDATED',
          actorUserId: applicant.id,
          metadata: { changedFields: ['professionalTitle'] },
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(
      'Completed supervised training',
    );
    expect(JSON.stringify(events)).not.toContain('Associate counselor');
  });

  it('requires a current PLATFORM_ADMIN assignment on every review endpoint', async () => {
    const applicant = await account();
    const profile = await apply(applicant.token);
    const legacy = await account(RoleCode.ADMIN, RoleCode.PLATFORM_ADMIN);
    const client = await account();
    const counselor = await account(RoleCode.COUNSELOR);
    await db.counselorProfile.create({
      data: { userId: counselor.id, approvalStatus: 'APPROVED' },
    });
    const organizationAdmin = await account();
    const org = await db.organization.create({ data: { name: randomUUID() } });
    await db.organizationMembership.create({
      data: {
        userId: organizationAdmin.id,
        organizationId: org.id,
        permission: 'ORG_ADMIN',
      },
    });
    const revokedAdmin = await account(
      RoleCode.PLATFORM_ADMIN,
      RoleCode.PLATFORM_ADMIN,
    );
    await get(revokedAdmin.token, review).expect(200);
    await db.userRole.updateMany({
      where: { userId: revokedAdmin.id },
      data: { revokedAt: new Date() },
    });

    const idPath = `${review}/${profile.id}`;
    for (const { token } of [
      legacy,
      client,
      counselor,
      organizationAdmin,
      revokedAdmin,
    ]) {
      for (const path of [review, idPath, `${idPath}/history`]) {
        await get(token, path).expect(403);
      }
      for (const action of ['approve', 'reject', 'suspend', 'reinstate']) {
        await post(token, `${idPath}/${action}`, {
          reason: 'Synthetic reason',
        }).expect(403);
      }
    }
  });

  it('prevents an administrator from deciding their own application', async () => {
    const admin = await account(RoleCode.PLATFORM_ADMIN);
    const profile = await apply(admin.token);
    await post(admin.token, `${review}/${profile.id}/approve`).expect(403);
    expect((await get(admin.token, mine).expect(200)).body).toMatchObject({
      approvalStatus: 'PENDING',
    });
  });

  it('keeps counselor review independent from an inactive account during reinstatement', async () => {
    const admin = await account(RoleCode.PLATFORM_ADMIN);
    const applicant = await account();
    const profile = await apply(applicant.token);
    const idPath = `${review}/${profile.id}`;
    await post(admin.token, `${idPath}/suspend`, {
      reason: 'Review required',
    }).expect(409);
    await post(admin.token, `${idPath}/approve`).expect(200);
    await post(admin.token, `${idPath}/suspend`, { reason: '<review>' }).expect(
      400,
    );
    const suspension = await post(admin.token, `${idPath}/suspend`, {
      reason: 'Review required',
    }).expect(200);
    expect(suspension.body).toMatchObject({
      approvalStatus: 'SUSPENDED',
      suspendedById: admin.id,
    });
    await get(applicant.token, '/counselor/diaries').expect(403);
    const activeAccount = await db.user.findUniqueOrThrow({
      where: { id: applicant.id },
    });
    expect(activeAccount.status).toBe('ACTIVE');

    await db.user.update({
      where: { id: applicant.id },
      data: { status: 'INACTIVE' },
    });
    await post(admin.token, `${idPath}/reinstate`, { reason: '   ' }).expect(
      400,
    );
    const reinstatement = await post(admin.token, `${idPath}/reinstate`, {
      reason: 'Review complete',
    }).expect(200);
    expect(reinstatement.body).toMatchObject({ approvalStatus: 'APPROVED' });
    const inactiveAccount = await db.user.findUniqueOrThrow({
      where: { id: applicant.id },
    });
    expect(inactiveAccount.status).toBe('INACTIVE');
    await get(applicant.token, '/counselor/diaries').expect(401);

    const history = await get(admin.token, `${idPath}/history`).expect(200);
    expect(history.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'COUNSELOR_SUSPENDED',
          actorUserId: admin.id,
          metadata: {
            from: 'APPROVED',
            to: 'SUSPENDED',
            reason: 'Review required',
            revokedGrantCount: 0,
          },
        }),
        expect.objectContaining({
          action: 'COUNSELOR_REINSTATED',
          actorUserId: admin.id,
          metadata: {
            from: 'SUSPENDED',
            to: 'APPROVED',
            reason: 'Review complete',
          },
        }),
      ]),
    );
  });
});
