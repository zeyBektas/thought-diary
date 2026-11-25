import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';
import { AuthService } from '../../src/modules/auth/auth.service';

describe('isolated current-user authorization', () => {
  let app: INestApplication;
  let db: PrismaService;
  const password = 'fixture-password';
  const server = () => app.getHttpServer() as Server;
  const bearer = (token: string) => `Bearer ${token}`;

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
    for (const code of [
      RoleCode.CLIENT,
      RoleCode.COUNSELOR,
      RoleCode.ADMIN,
      RoleCode.PLATFORM_ADMIN,
    ])
      await db.role.upsert({ where: { code }, update: {}, create: { code } });
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  async function register() {
    const email = `${randomUUID()}@example.test`;
    const response = await request(server())
      .post('/auth/register')
      .send({ email, password, firstName: 'Synthetic', lastName: 'Person' });
    expect(response.status).toBe(201);
    const body = response.body as {
      user: { id: string };
      accessToken: string;
      refreshToken: string;
    };
    return { email, ...body };
  }

  async function role(code: RoleCode) {
    return db.role.findUniqueOrThrow({ where: { code } });
  }

  it('uses current assignments rather than an old JWT role and supports simultaneous roles', async () => {
    const account = await register();
    const clientRole = await role(RoleCode.CLIENT);
    const counselorRole = await role(RoleCode.COUNSELOR);
    const oldToken = app
      .get(JwtService)
      .sign({ sub: account.user.id, email: account.email, role: 'COUNSELOR' });
    const get = (path: string) =>
      request(server()).get(path).set('Authorization', bearer(oldToken));
    const me = await get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      userId: account.user.id,
      email: account.email,
      status: 'ACTIVE',
      roles: ['CLIENT'],
      role: 'CLIENT',
    });
    expect((await get('/counselor/diaries')).status).toBe(403);
    expect((await get('/relationships/shareable-counselors')).status).toBe(200);

    await db.userRole.create({
      data: { userId: account.user.id, roleId: counselorRole.id },
    });
    expect((await get('/counselor/diaries')).status).toBe(403);
    await db.counselorProfile.create({
      data: { userId: account.user.id, approvalStatus: 'APPROVED' },
    });
    const dual = await get('/auth/me');
    expect(dual.body).toMatchObject({ counselorEligible: true });
    expect((dual.body as { roles: string[] }).roles.sort()).toEqual([
      'CLIENT',
      'COUNSELOR',
    ]);
    expect((await get('/counselor/diaries')).status).toBe(200);
    expect((await get('/relationships/shareable-counselors')).status).toBe(200);

    const clientAssignment = await db.userRole.findFirstOrThrow({
      where: {
        userId: account.user.id,
        roleId: clientRole.id,
        revokedAt: null,
      },
    });
    await db.userRole.update({
      where: { id: clientAssignment.id },
      data: { revokedAt: new Date() },
    });
    const counselorOnly = await get('/auth/me');
    // role is legacy compatibility data; roles is the current authorization state.
    expect(counselorOnly.body).toMatchObject({
      role: 'CLIENT',
      roles: ['COUNSELOR'],
    });
    expect((await get('/counselor/diaries')).status).toBe(200);
    expect((await get('/relationships/shareable-counselors')).status).toBe(403);
    await db.userRole.create({
      data: { userId: account.user.id, roleId: clientRole.id },
    });
    expect(
      await db.userRole.count({
        where: { userId: account.user.id, roleId: clientRole.id },
      }),
    ).toBe(2);
    const counselorAssignment = await db.userRole.findFirstOrThrow({
      where: {
        userId: account.user.id,
        roleId: counselorRole.id,
        revokedAt: null,
      },
    });
    await db.userRole.update({
      where: { id: counselorAssignment.id },
      data: { revokedAt: new Date() },
    });
    expect((await get('/counselor/diaries')).status).toBe(403);
    expect((await get('/relationships/shareable-counselors')).status).toBe(200);
    expect((await get('/auth/me')).body).toMatchObject({
      role: 'CLIENT',
      roles: ['CLIENT'],
      counselorEligible: false,
    });
  });

  it('lists both sides of a dual-role user’s relationships without exposing another user’s relationships', async () => {
    const account = await register();
    const client = await register();
    const other = await register();
    const counselorRole = await role(RoleCode.COUNSELOR);
    await db.userRole.createMany({
      data: [
        { userId: account.user.id, roleId: counselorRole.id },
        { userId: other.user.id, roleId: counselorRole.id },
      ],
    });
    await db.counselorProfile.create({
      data: { userId: other.user.id, approvalStatus: 'APPROVED' },
    });
    const asCounselor = await db.careRelationship.create({
      data: {
        counselorId: account.user.id,
        clientId: client.user.id,
        status: 'ACTIVE',
      },
    });
    const asClient = await db.careRelationship.create({
      data: {
        counselorId: other.user.id,
        clientId: account.user.id,
        status: 'ACTIVE',
      },
    });
    const unrelated = await db.careRelationship.create({
      data: {
        counselorId: other.user.id,
        clientId: client.user.id,
        status: 'ACTIVE',
      },
    });
    const getRelationships = () =>
      request(server())
        .get('/relationships')
        .set('Authorization', bearer(account.accessToken));
    const unapproved = await getRelationships();
    expect(unapproved.status).toBe(200);
    expect(
      (unapproved.body as Array<{ id: string }>).map(({ id }) => id),
    ).toEqual([asClient.id]);
    await db.counselorProfile.create({
      data: { userId: account.user.id, approvalStatus: 'APPROVED' },
    });
    const response = await getRelationships();
    expect(response.status).toBe(200);
    const ids = (response.body as Array<{ id: string }>).map(({ id }) => id);
    expect(ids).toEqual(expect.arrayContaining([asCounselor.id, asClient.id]));
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(unrelated.id);
  });

  it('does not turn a legacy ADMIN assignment or JWT claim into PLATFORM_ADMIN', async () => {
    const adminRole = await role(RoleCode.ADMIN);
    const admin = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Legacy',
        lastName: 'Admin',
        passwordHash: 'fixture',
        roleId: adminRole.id,
        roleAssignments: { create: { roleId: adminRole.id } },
      },
    });
    const token = app
      .get(JwtService)
      .sign({ sub: admin.id, email: admin.email, role: 'PLATFORM_ADMIN' });
    const response = await request(server())
      .get('/auth/me')
      .set('Authorization', bearer(token));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ role: 'ADMIN', roles: ['ADMIN'] });
    expect((response.body as { roles: string[] }).roles).not.toContain(
      'PLATFORM_ADMIN',
    );
    expect(
      (
        await request(server())
          .get('/relationships')
          .set('Authorization', bearer(token))
      ).status,
    ).toBe(403);
  });

  it.each([
    ['suspended', { status: 'SUSPENDED' as const }],
    ['deactivated', { status: 'INACTIVE' as const }],
    ['soft-deleted', { deletedAt: new Date() }],
  ])(
    'rejects login, refresh and old access tokens for a %s account',
    async (_label, data) => {
      const account = await register();
      await db.user.update({ where: { id: account.user.id }, data });
      expect(
        (
          await request(server())
            .post('/auth/login')
            .send({ email: account.email, password })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(server())
            .post('/auth/refresh')
            .send({ refreshToken: account.refreshToken })
        ).status,
      ).toBe(401);
      for (const path of [
        '/auth/me',
        '/diaries',
        '/relationships',
        '/relationships/shareable-counselors',
      ]) {
        const response = await request(server())
          .get(path)
          .set('Authorization', bearer(account.accessToken));
        expect(response.status).toBe(401);
      }
    },
  );

  it('rejects an in-flight refresh when the account is suspended before rotation', async () => {
    const account = await register();
    const auth = app.get(AuthService);
    const internal = auth as unknown as {
      prepareTokens: AuthService['prepareTokens'];
    };
    const prepareTokens = internal.prepareTokens;
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    let resumeRefresh!: () => void;
    const release = new Promise<void>((resolve) => {
      resumeRefresh = resolve;
    });
    // Token preparation follows the initial account check and precedes rotation.
    const spy = jest
      .spyOn(internal, 'prepareTokens')
      .mockImplementationOnce(async (...args) => {
        signalPaused();
        await release;
        return Reflect.apply(prepareTokens, auth, args);
      });

    const refreshStatus = request(server())
      .post('/auth/refresh')
      .send({ refreshToken: account.refreshToken })
      .then(({ status }) => status);
    try {
      expect(
        await Promise.race([
          paused.then(() => 'paused'),
          refreshStatus.then(() => 'finished'),
        ]),
      ).toBe('paused');
      await auth.suspendAccount(account.user.id);
    } finally {
      resumeRefresh();
      try {
        await refreshStatus;
      } finally {
        spy.mockRestore();
      }
    }

    expect(await refreshStatus).toBe(401);
    const tokens = await db.refreshToken.findMany({
      where: { userId: account.user.id },
      select: { revokedAt: true },
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].revokedAt).toBeInstanceOf(Date);
  });

  it('atomically suspends an account and revokes every refresh token without deleting its diary or grants', async () => {
    const account = await register();
    const login = await request(server())
      .post('/auth/login')
      .send({ email: account.email, password });
    expect(login.status).toBe(200);
    const second = login.body as { refreshToken: string };
    const counselorRole = await role(RoleCode.COUNSELOR);
    const counselor = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Synthetic',
        lastName: 'Counselor',
        passwordHash: 'fixture',
        roleId: counselorRole.id,
        roleAssignments: { create: { roleId: counselorRole.id } },
        counselorProfile: { create: { approvalStatus: 'APPROVED' } },
      },
    });
    const relationship = await db.careRelationship.create({
      data: {
        counselorId: counselor.id,
        clientId: account.user.id,
        status: 'ACTIVE',
      },
    });
    const journal = await db.journal.create({
      data: {
        userId: account.user.id,
        entryType: 'FREE_JOURNAL',
        visibility: 'COUNSELOR',
        content: { text: 'synthetic fixture' },
      },
    });
    const grant = await db.journalShare.create({
      data: { journalId: journal.id, relationshipId: relationship.id },
    });
    const counselorToken = app
      .get(JwtService)
      .sign({ sub: counselor.id, email: counselor.email, role: 'COUNSELOR' });
    const readDiary = () =>
      request(server())
        .get(`/counselor/diaries/${journal.id}`)
        .set('Authorization', bearer(counselorToken));
    expect((await readDiary()).status).toBe(200);
    await app.get(AuthService).suspendAccount(account.user.id);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: account.user.id } }))
        .status,
    ).toBe('SUSPENDED');
    const tokens = await db.refreshToken.findMany({
      where: { userId: account.user.id },
    });
    expect(tokens).toHaveLength(2);
    expect(tokens.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
    for (const refreshToken of [account.refreshToken, second.refreshToken])
      expect(
        (await request(server()).post('/auth/refresh').send({ refreshToken }))
          .status,
      ).toBe(401);
    expect(
      (
        await request(server())
          .get('/auth/me')
          .set('Authorization', bearer(account.accessToken))
      ).status,
    ).toBe(401);
    expect(
      await db.journal.findUnique({ where: { id: journal.id } }),
    ).not.toBeNull();
    expect(
      await db.journalShare.findUnique({ where: { id: grant.id } }),
    ).not.toBeNull();
    expect((await readDiary()).status).toBe(404);
  });
});
