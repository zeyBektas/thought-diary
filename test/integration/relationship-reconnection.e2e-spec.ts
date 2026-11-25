import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RoleCode, type CareRelationship, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

describe('isolated relationship reconnection', () => {
  let app: INestApplication;
  let db: PrismaService;
  let clientId: string;
  let counselorId: string;
  let clientToken: string;
  let counselorToken: string;
  const server = () => app.getHttpServer() as Server;
  const auth = (token: string) => `Bearer ${token}`;

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
    const clientRole = await db.role.upsert({
      where: { code: RoleCode.CLIENT },
      update: {},
      create: { code: RoleCode.CLIENT },
    });
    const counselorRole = await db.role.upsert({
      where: { code: RoleCode.COUNSELOR },
      update: {},
      create: { code: RoleCode.COUNSELOR },
    });
    const make = (roleId: string) =>
      db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          firstName: 'Test',
          lastName: 'Person',
          passwordHash: 'fixture',
          roleId,
          roleAssignments: { create: { roleId } },
        },
      });
    const [client, counselor] = await Promise.all([
      make(clientRole.id),
      make(counselorRole.id),
    ]);
    await db.counselorProfile.create({
      data: { userId: counselor.id, approvalStatus: 'APPROVED' },
    });
    clientId = client.id;
    counselorId = counselor.id;
    const jwt = app.get(JwtService);
    clientToken = jwt.sign({
      sub: client.id,
      role: 'CLIENT',
      email: client.email,
    });
    counselorToken = jwt.sign({
      sub: counselor.id,
      role: 'COUNSELOR',
      email: counselor.email,
    });
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('creates and accepts a distinct relationship without restoring historical grants', async () => {
    const old = await db.careRelationship.create({
      data: { clientId, counselorId, status: 'ACTIVE' },
    });
    const journal = await db.journal.create({
      data: {
        userId: clientId,
        entryType: 'FREE_JOURNAL',
        visibility: 'COUNSELOR',
        content: {},
      },
    });
    await db.journalShare.create({
      data: { journalId: journal.id, relationshipId: old.id },
    });
    expect(
      (
        await request(server())
          .get(`/counselor/diaries/${journal.id}`)
          .set('Authorization', auth(counselorToken))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(server())
          .post('/relationships')
          .set('Authorization', auth(counselorToken))
          .send({ clientId })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(server())
          .patch(`/relationships/${old.id}/revoke`)
          .set('Authorization', auth(clientToken))
      ).status,
    ).toBe(200);
    const revoked = await db.careRelationship.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(revoked.status).toBe('REVOKED');
    expect(
      await db.journalShare.count({ where: { relationshipId: old.id } }),
    ).toBe(0);
    expect(
      (
        await request(server())
          .get(`/counselor/diaries/${journal.id}`)
          .set('Authorization', auth(counselorToken))
      ).status,
    ).toBe(404);
    const list = await request(server())
      .get('/counselor/diaries')
      .set('Authorization', auth(counselorToken));
    expect(list.status).toBe(200);
    expect(
      (list.body as { entries: Array<{ id: string }> }).entries.map(
        (entry) => entry.id,
      ),
    ).not.toContain(journal.id);

    const sendRequest = () =>
      request(server())
        .post('/relationships')
        .set('Authorization', auth(counselorToken))
        .send({ clientId });
    const responses = await Promise.all([sendRequest(), sendRequest()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const created = responses.find((response) => response.status === 201)!;
    const newId = (created.body as { id: string }).id;
    expect(newId).not.toBe(old.id);
    expect((created.body as { status: string }).status).toBe('PENDING');
    expect((await sendRequest()).status).toBe(409);
    expect(
      await db.careRelationship.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(revoked);
    expect(
      (
        await request(server())
          .patch(`/relationships/${newId}`)
          .set('Authorization', auth(clientToken))
          .send({ status: 'ACTIVE' })
      ).status,
    ).toBe(200);
    expect((await sendRequest()).status).toBe(409);
    expect(
      await db.journalShare.count({ where: { journalId: journal.id } }),
    ).toBe(0);
    expect(
      (
        await request(server())
          .get(`/counselor/diaries/${journal.id}`)
          .set('Authorization', auth(counselorToken))
      ).status,
    ).toBe(404);
    const reconnectedList = await request(server())
      .get('/counselor/diaries')
      .set('Authorization', auth(counselorToken));
    expect(reconnectedList.status).toBe(200);
    expect(
      (reconnectedList.body as { entries: Array<{ id: string }> }).entries.map(
        (entry) => entry.id,
      ),
    ).not.toContain(journal.id);
    const shares = await request(server())
      .get(`/diaries/${journal.id}/shares`)
      .set('Authorization', auth(clientToken));
    expect(shares.status).toBe(200);
    expect((shares.body as { recipients: unknown[] }).recipients).toEqual([]);
    const shareVersion = (shares.body as { shareVersion: string }).shareVersion;
    const replacement = await request(server())
      .put(`/diaries/${journal.id}/shares`)
      .set('Authorization', auth(clientToken))
      .send({ recipientRelationshipIds: [newId], shareVersion });
    expect(replacement.status).toBe(200);
    expect(
      await db.journalShare.count({
        where: { journalId: journal.id, relationshipId: newId },
      }),
    ).toBe(1);
    expect(
      await db.journalShare.count({ where: { relationshipId: old.id } }),
    ).toBe(0);
    expect(
      (
        await request(server())
          .get(`/counselor/diaries/${journal.id}`)
          .set('Authorization', auth(counselorToken))
      ).status,
    ).toBe(200);
    expect(
      await db.careRelationship.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(revoked);
  });

  it.each(['PENDING', 'ACTIVE', 'REJECTED'] as const)(
    'blocks duplicate %s relationships even when soft-deleted',
    async (status) => {
      const role = await db.role.findUniqueOrThrow({
        where: { code: RoleCode.CLIENT },
      });
      const client = await db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          firstName: 'Other',
          lastName: 'Client',
          passwordHash: 'fixture',
          roleId: role.id,
          roleAssignments: { create: { roleId: role.id } },
        },
      });
      await db.careRelationship.create({
        data: {
          clientId: client.id,
          counselorId,
          status,
          deletedAt: new Date(),
        },
      });
      const response = await request(server())
        .post('/relationships')
        .set('Authorization', auth(counselorToken))
        .send({ clientId: client.id });
      expect(response.status).toBe(409);
      await expect(
        db.careRelationship.create({
          data: { clientId: client.id, counselorId, status: 'PENDING' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    },
  );

  it('allows multiple revoked records but at most one non-revoked record', async () => {
    const role = await db.role.findUniqueOrThrow({
      where: { code: RoleCode.CLIENT },
    });
    const client = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Index',
        lastName: 'Client',
        passwordHash: 'fixture',
        roleId: role.id,
        roleAssignments: { create: { roleId: role.id } },
      },
    });
    const pair = { clientId: client.id, counselorId };
    const first = await db.careRelationship.create({
      data: { ...pair, status: 'REVOKED' },
    });
    const second = await db.careRelationship.create({
      data: { ...pair, status: 'REVOKED' },
    });
    expect(first.id).not.toBe(second.id);
    await db.careRelationship.create({ data: { ...pair, status: 'PENDING' } });
    await expect(
      db.careRelationship.create({ data: { ...pair, status: 'ACTIVE' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await db.careRelationship.count({
        where: { ...pair, status: 'REVOKED' },
      }),
    ).toBe(2);
    expect(
      await db.careRelationship.count({
        where: { ...pair, status: { not: 'REVOKED' } },
      }),
    ).toBe(1);
  });

  it('enforces uniqueness when concurrent requests both pass the pre-check', async () => {
    const role = await db.role.findUniqueOrThrow({
      where: { code: RoleCode.CLIENT },
    });
    const client = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Race',
        lastName: 'Client',
        passwordHash: 'fixture',
        roleId: role.id,
        roleAssignments: { create: { roleId: role.id } },
      },
    });
    const delegate = db.careRelationship as unknown as {
      findFirst: (
        args: Prisma.CareRelationshipFindFirstArgs,
      ) => Promise<CareRelationship | null>;
    };
    const original = delegate.findFirst.bind(delegate) as (
      args: Prisma.CareRelationshipFindFirstArgs,
    ) => Promise<CareRelationship | null>;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checked = 0;
    const spy = jest
      .spyOn(delegate, 'findFirst')
      .mockImplementation(async (args) => {
        const result = await original(args);
        checked += 1;
        if (checked === 2) release();
        await barrier;
        return result;
      });
    try {
      const send = () =>
        request(server())
          .post('/relationships')
          .set('Authorization', auth(counselorToken))
          .send({ clientId: client.id });
      const responses = await Promise.all([send(), send()]);
      expect(checked).toBe(2);
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      expect(
        await db.careRelationship.count({
          where: {
            clientId: client.id,
            counselorId,
            status: { not: 'REVOKED' },
          },
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
