import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RoleCode } from '@prisma/client';
import { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';
import { UsersService } from '../../src/modules/users/users.service';
import { BCRYPT_HASH_ROUNDS } from '../../src/modules/auth/auth.constants';
import { DiariesService } from '../../src/modules/diaries/diaries.service';
import { RelationshipsService } from '../../src/modules/relationships/relationships.service';

describe('isolated diary sharing', () => {
  let app: INestApplication;
  let db: PrismaService;
  let client: { id: string; token: string };
  let counselor: { id: string; token: string };
  let relationshipId: string;
  let journalId: string;
  const bearer = (token: string) => `Bearer ${token}`;
  const password = 'fixture-password';
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
    for (const code of [RoleCode.CLIENT, RoleCode.COUNSELOR])
      await db.role.upsert({ where: { code }, update: {}, create: { code } });
    const role = await db.role.findUniqueOrThrow({
      where: { code: RoleCode.COUNSELOR },
    });
    const user = await app.get(UsersService).create({
      email: 'share-counselor@example.test',
      firstName: 'Test',
      lastName: 'Counselor',
      roleId: role.id,
      passwordHash: await bcrypt.hash(password, BCRYPT_HASH_ROUNDS),
    });
    await db.counselorProfile.create({
      data: { userId: user.id, approvalStatus: 'APPROVED' },
    });
    const login = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ email: user.email, password });
    counselor = {
      id: user.id,
      token: (login.body as { accessToken: string }).accessToken,
    };
    const registered = await request(app.getHttpServer() as Server)
      .post('/auth/register')
      .send({
        email: 'share-client@example.test',
        password,
        firstName: 'Test',
        lastName: 'Client',
      });
    const body = registered.body as {
      user: { id: string };
      accessToken: string;
    };
    client = { id: body.user.id, token: body.accessToken };
    const relation = await db.careRelationship.create({
      data: {
        clientId: client.id,
        counselorId: counselor.id,
        status: 'ACTIVE',
      },
    });
    relationshipId = relation.id;
    const journal = await db.journal.create({
      data: {
        userId: client.id,
        entryType: 'FREE_JOURNAL',
        visibility: 'COUNSELOR',
        content: {},
      },
    });
    journalId = journal.id;
    await db.journalShare.create({ data: { journalId, relationshipId } });
  });
  it('excludes grants for another client while retaining valid recipients and stored grants', async () => {
    const role = await db.role.findUniqueOrThrow({
      where: { code: RoleCode.CLIENT },
    });
    const otherClient = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Other',
        lastName: 'Client',
        passwordHash: 'fixture',
        roleId: role.id,
        roleAssignments: { create: { roleId: role.id } },
      },
    });
    const otherRelationship = await db.careRelationship.create({
      data: {
        clientId: otherClient.id,
        counselorId: counselor.id,
        status: 'ACTIVE',
      },
    });
    const journal = await db.journal.create({
      data: {
        userId: client.id,
        entryType: 'FREE_JOURNAL',
        visibility: 'COUNSELOR',
        content: {},
      },
    });
    await db.journalShare.createMany({
      data: [
        { journalId: journal.id, relationshipId },
        { journalId: journal.id, relationshipId: otherRelationship.id },
      ],
    });
    const response = await request(app.getHttpServer() as Server)
      .get(`/diaries/${journal.id}/shares`)
      .set('Authorization', bearer(client.token));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      shareVersion: expect.any(String) as string,
      recipients: [
        {
          relationshipId,
          counselor: {
            id: counselor.id,
            firstName: 'Test',
            lastName: 'Counselor',
            username: null,
          },
        },
      ],
    });
    expect(
      await db.journalShare.count({ where: { journalId: journal.id } }),
    ).toBe(2);
  });
  it('rejects stale replacements without changing content, visibility, revision or grants', async () => {
    const server = app.getHttpServer() as Server;
    const get = () =>
      request(server)
        .get(`/diaries/${journalId}/shares`)
        .set('Authorization', bearer(client.token));
    const a = await get();
    const b = await get();
    const old = (a.body as { shareVersion: string }).shareVersion;
    expect((b.body as { shareVersion: string }).shareVersion).toBe(old);
    const replacement = await request(server)
      .put(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(client.token))
      .send({ shareVersion: old, recipientRelationshipIds: [] });
    expect(replacement.status).toBe(200);
    expect(
      (replacement.body as { shareVersion: string }).shareVersion,
    ).not.toBe(old);
    const before = await db.journal.findUniqueOrThrow({
      where: { id: journalId },
    });
    const stalePut = await request(server)
      .put(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(client.token))
      .send({ shareVersion: old, recipientRelationshipIds: [relationshipId] });
    const stalePatch = await request(server)
      .patch(`/diaries/${journalId}`)
      .set('Authorization', bearer(client.token))
      .send({
        shareVersion: old,
        recipientRelationshipIds: [relationshipId],
        content: { stale: true },
        visibility: 'PRIVATE',
      });
    expect(stalePut.status).toBe(409);
    expect(stalePatch.status).toBe(409);
    expect(
      await db.journal.findUniqueOrThrow({ where: { id: journalId } }),
    ).toEqual(before);
    expect(await db.journalShare.count({ where: { journalId } })).toBe(0);
    const fresh = await get();
    const current = (fresh.body as { shareVersion: string }).shareVersion;
    expect(
      (
        await request(server)
          .patch(`/diaries/${journalId}`)
          .set('Authorization', bearer(client.token))
          .send({ content: { ok: true } })
      ).status,
    ).toBe(200);
    expect(((await get()).body as { shareVersion: string }).shareVersion).toBe(
      current,
    );
    const put = await request(server)
      .put(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(client.token))
      .send({
        shareVersion: current,
        recipientRelationshipIds: [relationshipId],
      });
    expect(put.status).toBe(200);
  });

  it('invalidates versions for both visibility transitions and validates version contracts', async () => {
    const server = app.getHttpServer() as Server;
    const created = await request(server)
      .post('/diaries')
      .set('Authorization', bearer(client.token))
      .send({
        entryType: 'FREE_JOURNAL',
        content: {},
        visibility: 'COUNSELOR',
      });
    expect(created.status).toBe(201);
    expect(
      (created.body as { shareRevision?: unknown }).shareRevision,
    ).toBeUndefined();
    const id = (created.body as { id: string }).id;
    const get = () =>
      request(server)
        .get(`/diaries/${id}/shares`)
        .set('Authorization', bearer(client.token));
    const initial = await get();
    expect((initial.body as { recipients: unknown[] }).recipients).toEqual([]);
    const v0 = (initial.body as { shareVersion: string }).shareVersion;
    expect(
      (
        await request(server)
          .put(`/diaries/${id}/shares`)
          .set('Authorization', bearer(client.token))
          .send({ recipientRelationshipIds: [] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .put(`/diaries/${id}/shares`)
          .set('Authorization', bearer(client.token))
          .send({ shareVersion: 'invalid', recipientRelationshipIds: [] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .patch(`/diaries/${id}`)
          .set('Authorization', bearer(client.token))
          .send({ recipientRelationshipIds: [] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .patch(`/diaries/${id}`)
          .set('Authorization', bearer(client.token))
          .send({ shareVersion: v0 })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .patch(`/diaries/${id}`)
          .set('Authorization', bearer(client.token))
          .send({ visibility: 'PRIVATE' })
      ).status,
    ).toBe(200);
    const v1 = ((await get()).body as { shareVersion: string }).shareVersion;
    expect(v1).not.toBe(v0);
    expect(
      (
        await request(server)
          .patch(`/diaries/${id}`)
          .set('Authorization', bearer(client.token))
          .send({ visibility: 'COUNSELOR' })
      ).status,
    ).toBe(200);
    const v2 = ((await get()).body as { shareVersion: string }).shareVersion;
    expect(v2).not.toBe(v1);
    expect(
      (
        await request(server)
          .put(`/diaries/${id}/shares`)
          .set('Authorization', bearer(client.token))
          .send({
            shareVersion: v0,
            recipientRelationshipIds: [relationshipId],
          })
      ).status,
    ).toBe(409);
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('rolls back a diary update and recipient replacement when grant insertion fails', async () => {
    const server = app.getHttpServer() as Server;
    const created = await request(server)
      .post('/diaries')
      .set('Authorization', bearer(client.token))
      .send({
        entryType: 'FREE_JOURNAL',
        content: { text: 'before rollback test' },
        visibility: 'COUNSELOR',
        recipientRelationshipIds: [relationshipId],
      });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const before = await db.journal.findUniqueOrThrow({ where: { id } });
    const grantsBefore = await db.journalShare.findMany({
      where: { journalId: id },
      orderBy: { id: 'asc' },
    });
    expect(grantsBefore).toHaveLength(1);
    const getShares = () =>
      request(server)
        .get(`/diaries/${id}/shares`)
        .set('Authorization', bearer(client.token));
    const initialShares = await getShares();
    expect(initialShares.status).toBe(200);
    const version = (initialShares.body as { shareVersion: string })
      .shareVersion;

    // setup.ts verifies the disposable container before this suite connects.
    // The marker limits the test trigger to this journal's attempted update.
    await db.$executeRaw`CREATE FUNCTION integration_fail_share_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM journals WHERE id = NEW."journalId" AND content = '{"rollback_marker":true}'::jsonb) THEN
          IF NOT EXISTS (SELECT 1 FROM journals WHERE id = NEW."journalId" AND "shareRevision" = 1 AND visibility = 'COUNSELOR')
             OR EXISTS (SELECT 1 FROM journal_shares WHERE "journalId" = NEW."journalId") THEN
            RAISE EXCEPTION 'integration rollback test reached incorrect state';
          END IF;
          RAISE EXCEPTION 'integration rollback test injected failure';
        END IF;
        RETURN NEW;
      END;
    $$`;
    try {
      await db.$executeRaw`CREATE TRIGGER integration_fail_share_insert BEFORE INSERT ON journal_shares FOR EACH ROW EXECUTE FUNCTION integration_fail_share_insert()`;
      await expect(
        app.get(DiariesService).update(client.id, id, {
          content: { rollback_marker: true },
          recipientRelationshipIds: [relationshipId],
          shareVersion: version,
        }),
      ).rejects.toThrow('integration rollback test injected failure');
    } finally {
      try {
        await db.$executeRaw`DROP TRIGGER IF EXISTS integration_fail_share_insert ON journal_shares`;
      } finally {
        await db.$executeRaw`DROP FUNCTION IF EXISTS integration_fail_share_insert()`;
      }
    }

    expect(await db.journal.findUniqueOrThrow({ where: { id } })).toEqual(
      before,
    );
    expect(
      await db.journalShare.findMany({
        where: { journalId: id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(grantsBefore);
    const after = await getShares();
    expect(after.status).toBe(200);
    expect(after.body).toEqual(initialShares.body);
    // Prove the original token remains acceptable, not merely byte-identical.
    const retry = await request(server)
      .put(`/diaries/${id}/shares`)
      .set('Authorization', bearer(client.token))
      .send({
        recipientRelationshipIds: [relationshipId],
        shareVersion: version,
      });
    expect(retry.status).toBe(200);
  });

  it('creates explicit grants, enforces validation and database uniqueness, and rolls back invalid replacements', async () => {
    const handler = jest.spyOn(
      app.get(RelationshipsService),
      'shareableCounselors',
    );
    const testServer = app.getHttpServer() as Server;
    const available = await request(testServer)
      .get('/relationships/shareable-counselors')
      .set('Authorization', bearer(client.token));
    if (available.status !== 200) {
      const body = available.body as { statusCode?: unknown; error?: unknown };
      console.error('shareable-counselors diagnostic', {
        status: available.status,
        body: {
          statusCode:
            typeof body?.statusCode === 'number' ? body.statusCode : undefined,
          error:
            typeof body?.error === 'string' &&
            ['Not Found', 'Forbidden', 'Unauthorized'].includes(body.error)
              ? body.error
              : '[redacted]',
        },
        handlerInvoked: handler.mock.calls.length > 0,
        intendedApp: testServer === app.getHttpServer(),
      });
    }
    expect(available.status).toBe(200);
    handler.mockRestore();
    expect(available.body).toEqual({
      counselors: [
        {
          relationshipId,
          counselor: {
            id: counselor.id,
            firstName: 'Test',
            lastName: 'Counselor',
            username: null,
          },
        },
      ],
    });
    const created = await request(app.getHttpServer() as Server)
      .post('/diaries')
      .set('Authorization', bearer(client.token))
      .send({
        entryType: 'FREE_JOURNAL',
        content: {},
        visibility: 'COUNSELOR',
        recipientRelationshipIds: [relationshipId],
      });
    expect(created.status).toBe(201);
    journalId = (created.body as { id: string }).id;
    expect(await db.journalShare.count({ where: { journalId } })).toBe(1);
    const initialShares = await request(app.getHttpServer() as Server)
      .get(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(client.token));
    const initialVersion = (initialShares.body as { shareVersion: string })
      .shareVersion;
    await expect(
      db.journalShare.create({ data: { journalId, relationshipId } }),
    ).rejects.toThrow();
    await expect(
      db.$transaction(async (tx) => {
        await tx.journalShare.deleteMany({ where: { journalId } });
        await tx.journalShare.create({
          data: { journalId, relationshipId: 'nonexistent-relationship' },
        });
      }),
    ).rejects.toThrow();
    expect(await db.journalShare.count({ where: { journalId } })).toBe(1);
    const invalid = await request(app.getHttpServer() as Server)
      .put(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(client.token))
      .send({
        recipientRelationshipIds: [relationshipId, relationshipId],
        shareVersion: initialVersion,
      });
    expect(invalid.status).toBe(400);
    expect(await db.journalShare.count({ where: { journalId } })).toBe(1);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .get(`/diaries/${journalId}/shares`)
          .set('Authorization', bearer(counselor.token))
      ).status,
    ).toBe(403);
  });
  it('serializes concurrent sharing and revocation without restoring grants after reactivation', async () => {
    const server = app.getHttpServer() as Server;
    const initial = await request(server)
      .get(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(client.token));
    const shareVersion = (initial.body as { shareVersion: string })
      .shareVersion;
    const [share, revoke] = await Promise.all([
      request(server)
        .put(`/diaries/${journalId}/shares`)
        .set('Authorization', bearer(client.token))
        .send({ recipientRelationshipIds: [relationshipId], shareVersion }),
      request(server)
        .patch(`/relationships/${relationshipId}/revoke`)
        .set('Authorization', bearer(client.token)),
    ]);
    expect([200, 409]).toContain(share.status);
    expect(revoke.status).toBe(200);
    expect(await db.journalShare.count({ where: { relationshipId } })).toBe(0);
    await db.careRelationship.update({
      where: { id: relationshipId },
      data: { status: 'ACTIVE' },
    });
    expect(await db.journalShare.count({ where: { relationshipId } })).toBe(0);
    const stale = await request(server)
      .put(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(client.token))
      .send({ recipientRelationshipIds: [relationshipId], shareVersion });
    expect(stale.status).toBe(409);
    expect(await db.journalShare.count({ where: { relationshipId } })).toBe(0);
  });
});
