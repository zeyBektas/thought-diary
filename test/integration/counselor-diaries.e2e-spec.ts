import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RoleCode } from '@prisma/client';
import { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

describe('isolated counselor diary reads', () => {
  let app: INestApplication;
  let db: PrismaService;
  let counselorId: string,
    otherId: string,
    clientId: string,
    relationId: string,
    token: string,
    otherToken: string,
    clientRoleId: string,
    counselorRoleId: string;
  const auth = (value: string) => `Bearer ${value}`;
  const server = () => app.getHttpServer() as Server;
  const get = (path: string, value = token) =>
    request(server()).get(path).set('Authorization', auth(value));
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
    const cr = await db.role.upsert({
      where: { code: RoleCode.COUNSELOR },
      update: {},
      create: { code: RoleCode.COUNSELOR },
    });
    const ur = await db.role.upsert({
      where: { code: RoleCode.CLIENT },
      update: {},
      create: { code: RoleCode.CLIENT },
    });
    counselorRoleId = cr.id;
    clientRoleId = ur.id;
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
    const [c, other, client] = await Promise.all([
      make(cr.id),
      make(cr.id),
      make(ur.id),
    ]);
    counselorId = c.id;
    otherId = other.id;
    clientId = client.id;
    const jwt = app.get(JwtService);
    token = jwt.sign({ sub: c.id, role: 'COUNSELOR', email: c.email });
    otherToken = jwt.sign({
      sub: other.id,
      role: 'COUNSELOR',
      email: other.email,
    });
    relationId = (
      await db.careRelationship.create({
        data: { clientId, counselorId, status: 'ACTIVE' },
      })
    ).id;
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  async function entry(
    visibility: 'PRIVATE' | 'COUNSELOR' = 'COUNSELOR',
    grant = true,
  ) {
    const j = await db.journal.create({
      data: {
        userId: clientId,
        entryType: 'FREE_JOURNAL',
        visibility,
        content: { text: 'shared' },
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    });
    if (grant)
      await db.journalShare.create({
        data: { journalId: j.id, relationshipId: relationId },
      });
    return j;
  }
  it('returns an empty page for an eligible counselor without grants', async () => {
    const response = await get('/counselor/diaries', otherToken);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ entries: [], nextCursor: null });
  });
  it('enforces explicit grants and projects only allowed fields', async () => {
    const shared = await entry();
    const privateEntry = await entry('PRIVATE');
    const unshared = await entry('COUNSELOR', false);
    const deleted = await entry();
    await db.journal.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    const ok = await get(`/counselor/diaries/${shared.id}`);
    expect(ok.status).toBe(200);
    const list = await get('/counselor/diaries');
    const listed = (
      list.body as { entries: Array<{ id: string }> }
    ).entries.map((item) => item.id);
    expect(listed).toContain(shared.id);
    expect(listed).not.toContain(privateEntry.id);
    expect(listed).not.toContain(unshared.id);
    expect(listed).not.toContain(deleted.id);
    expect(Object.keys(ok.body as object).sort()).toEqual(
      [
        'client',
        'content',
        'createdAt',
        'entryType',
        'id',
        'intensityAfter',
        'intensityBefore',
        'primaryEmotion',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys((ok.body as { client: object }).client).sort()).toEqual([
      'firstName',
      'id',
      'lastName',
    ]);
    expect(
      Object.keys(
        (list.body as { entries: Array<Record<string, unknown>> }).entries[0],
      ).sort(),
    ).toEqual(
      [
        'client',
        'content',
        'createdAt',
        'entryType',
        'id',
        'intensityAfter',
        'intensityBefore',
        'primaryEmotion',
        'updatedAt',
      ].sort(),
    );
    const firstEmotion = (
      list.body as { entries: Array<{ primaryEmotion: object | null }> }
    ).entries[0].primaryEmotion;
    if (firstEmotion !== null)
      expect(Object.keys(firstEmotion).sort()).toEqual(['code', 'id']);
    const denied = await Promise.all([
      get(`/counselor/diaries/${shared.id}`, otherToken),
      get(`/counselor/diaries/${privateEntry.id}`),
      get(`/counselor/diaries/${unshared.id}`),
      get(`/counselor/diaries/${deleted.id}`),
      get(`/counselor/diaries/${randomUUID()}`),
    ]);
    for (const result of denied) {
      expect(result.status).toBe(404);
      expect(result.body).toEqual(denied[0].body);
    }
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(server())
        [method](`/counselor/diaries/${shared.id}`)
        .set('Authorization', auth(token))
        .send({});
      expect(response.status).toBe(404);
    }
  });
  it('rejects inconsistent grants and all non-active relationship states', async () => {
    const journal = await entry();
    const unrelated = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Other',
        lastName: 'Client',
        passwordHash: 'fixture',
        roleId: clientRoleId,
        roleAssignments: { create: { roleId: clientRoleId } },
      },
    });
    const bad = await db.careRelationship.create({
      data: { clientId: unrelated.id, counselorId: otherId, status: 'ACTIVE' },
    });
    await db.journalShare.create({
      data: { journalId: journal.id, relationshipId: bad.id },
    });
    expect(
      (await get(`/counselor/diaries/${journal.id}`, otherToken)).status,
    ).toBe(404);
    for (const status of ['PENDING', 'REJECTED', 'REVOKED'] as const) {
      await db.careRelationship.update({
        where: { id: relationId },
        data: { status },
      });
      expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
    }
    await db.careRelationship.update({
      where: { id: relationId },
      data: { status: 'ACTIVE', deletedAt: new Date() },
    });
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
    await db.careRelationship.update({
      where: { id: relationId },
      data: { deletedAt: null },
    });
    await db.journalShare.deleteMany({
      where: { journalId: journal.id, relationshipId: relationId },
    });
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
  });
  it('returns only active primary emotion metadata', async () => {
    const journal = await entry();
    const emotion = await db.emotion.create({
      data: { code: `TEST_${randomUUID()}` },
    });
    await db.journal.update({
      where: { id: journal.id },
      data: { primaryEmotionId: emotion.id },
    });
    const response = await get(`/counselor/diaries/${journal.id}`);
    expect(
      (response.body as { primaryEmotion: unknown }).primaryEmotion,
    ).toEqual({ id: emotion.id, code: emotion.code });
    await db.emotion.update({
      where: { id: emotion.id },
      data: { deletedAt: new Date() },
    });
    const deleted = await get(`/counselor/diaries/${journal.id}`);
    expect(
      (deleted.body as { primaryEmotion: unknown }).primaryEmotion,
    ).toBeNull();
  });
  it('checks current account and role state even for an old token', async () => {
    const journal = await entry();
    for (const data of [
      { status: 'INACTIVE' as const },
      { deletedAt: new Date() },
    ]) {
      await db.user.update({ where: { id: counselorId }, data });
      expect((await get('/counselor/diaries')).status).toBe(401);
      expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(401);
      await db.user.update({
        where: { id: counselorId },
        data: { status: 'ACTIVE', deletedAt: null, roleId: counselorRoleId },
      });
    }
    for (const data of [
      { status: 'INACTIVE' as const },
      { deletedAt: new Date() },
    ]) {
      await db.user.update({ where: { id: clientId }, data });
      expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
      await db.user.update({
        where: { id: clientId },
        data: { status: 'ACTIVE', deletedAt: null, roleId: clientRoleId },
      });
    }
    // Legacy roleId changes do not override current role assignments.
    await db.user.update({
      where: { id: counselorId },
      data: { roleId: clientRoleId },
    });
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(200);
    await db.user.update({
      where: { id: counselorId },
      data: { roleId: counselorRoleId },
    });
    await db.user.update({
      where: { id: clientId },
      data: { roleId: counselorRoleId },
    });
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(200);
    await db.user.update({
      where: { id: clientId },
      data: { roleId: clientRoleId },
    });

    // An old JWT cannot retain a revoked counselor assignment.
    const counselorAssignment = await db.userRole.findFirstOrThrow({
      where: { userId: counselorId, roleId: counselorRoleId, revokedAt: null },
    });
    await db.userRole.update({
      where: { id: counselorAssignment.id },
      data: { revokedAt: new Date() },
    });
    await db.userRole.create({
      data: { userId: counselorId, roleId: clientRoleId },
    });
    expect((await get('/counselor/diaries')).status).toBe(403);
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
    await db.userRole.create({
      data: { userId: counselorId, roleId: counselorRoleId },
    });

    const ownerAssignment = await db.userRole.findFirstOrThrow({
      where: { userId: clientId, roleId: clientRoleId, revokedAt: null },
    });
    await db.userRole.update({
      where: { id: ownerAssignment.id },
      data: { revokedAt: new Date() },
    });
    await db.userRole.create({
      data: { userId: clientId, roleId: counselorRoleId },
    });
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
    await db.userRole.create({
      data: { userId: clientId, roleId: clientRoleId },
    });
    for (const id of [clientRoleId, counselorRoleId]) {
      await db.role.update({ where: { id }, data: { deletedAt: new Date() } });
      expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
      if (id === counselorRoleId)
        expect((await get('/counselor/diaries')).status).toBe(403);
      await db.role.update({ where: { id }, data: { deletedAt: null } });
    }
  });
  it('paginates ties and continues after the cursor entry disappears', async () => {
    const baseline = await get('/counselor/diaries?limit=50');
    expect(baseline.status).toBe(200);
    const baselineIds = (
      baseline.body as { entries: Array<{ id: string }> }
    ).entries.map((item) => item.id);
    const visible = await Promise.all([entry(), entry()]);
    const inaccessible = await entry('PRIVATE');
    const future = new Date('2099-01-01T00:00:00.000Z');
    for (const journal of [...visible, inaccessible])
      await db.journal.update({
        where: { id: journal.id },
        data: { createdAt: future },
      });
    const first = await get('/counselor/diaries?limit=1');
    expect(first.status).toBe(200);
    const page = first.body as {
      entries: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    await db.journal.update({
      where: { id: page.entries[0].id },
      data: { deletedAt: new Date() },
    });
    const seen = new Set(page.entries.map((e) => e.id));
    let cursor: string | null = page.nextCursor;
    while (cursor) {
      const response = await get(`/counselor/diaries?limit=1&cursor=${cursor}`);
      expect(response.status).toBe(200);
      const body = response.body as {
        entries: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(body.entries).toHaveLength(1);
      expect(seen.has(body.entries[0].id)).toBe(false);
      seen.add(body.entries[0].id);
      cursor = body.nextCursor;
    }
    expect([...seen].sort()).toEqual(
      [...baselineIds, ...visible.map((item) => item.id)].sort(),
    );
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'cursor=bad'])
      expect((await get(`/counselor/diaries?${query}`)).status).toBe(400);
  });
  it('orders authorized pages, skips an interleaved private entry and continues after cursor relationship revocation', async () => {
    const makeUser = (roleId: string) =>
      db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          firstName: 'Page',
          lastName: 'Fixture',
          passwordHash: 'fixture',
          roleId,
          roleAssignments: { create: { roleId } },
        },
      });
    const [counselor, firstClient, secondClient] = await Promise.all([
      makeUser(counselorRoleId),
      makeUser(clientRoleId),
      makeUser(clientRoleId),
    ]);
    const pageToken = app
      .get(JwtService)
      .sign({ sub: counselor.id, role: 'COUNSELOR', email: counselor.email });
    const firstRel = await db.careRelationship.create({
      data: {
        clientId: firstClient.id,
        counselorId: counselor.id,
        status: 'ACTIVE',
      },
    });
    const secondRel = await db.careRelationship.create({
      data: {
        clientId: secondClient.id,
        counselorId: counselor.id,
        status: 'ACTIVE',
      },
    });
    const emotion = await db.emotion.create({
      data: { code: `PAGE_${randomUUID()}` },
    });
    const timestamp = new Date('2050-01-01T00:00:00.000Z');
    const ids = [
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ];
    for (const [index, id] of ids.entries()) {
      const first = index === 0;
      await db.journal.create({
        data: {
          id,
          userId: first ? firstClient.id : secondClient.id,
          entryType: 'FREE_JOURNAL',
          visibility: index === 1 ? 'PRIVATE' : 'COUNSELOR',
          content: {},
          createdAt: timestamp,
          primaryEmotionId: emotion.id,
        },
      });
      await db.journalShare.create({
        data: {
          journalId: id,
          relationshipId: first ? firstRel.id : secondRel.id,
        },
      });
    }
    const pageOne = await get('/counselor/diaries?limit=1', pageToken);
    expect(pageOne.status).toBe(200);
    const first = pageOne.body as {
      entries: Array<{ id: string; client: object; primaryEmotion: object }>;
      nextCursor: string | null;
    };
    expect(first.entries.map((row) => row.id)).toEqual([ids[0]]);
    expect(first.nextCursor).not.toBeNull();
    expect(Object.keys(first.entries[0]).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'entryType',
        'content',
        'primaryEmotion',
        'intensityBefore',
        'intensityAfter',
        'client',
      ].sort(),
    );
    expect(Object.keys(first.entries[0].client).sort()).toEqual([
      'firstName',
      'id',
      'lastName',
    ]);
    expect(first.entries[0].primaryEmotion).toEqual({
      id: emotion.id,
      code: emotion.code,
    });
    expect(Object.keys(first.entries[0].primaryEmotion).sort()).toEqual([
      'code',
      'id',
    ]);
    const revoke = await request(server())
      .patch(`/relationships/${firstRel.id}/revoke`)
      .set('Authorization', auth(pageToken));
    expect(revoke.status).toBe(200);
    expect((await get(`/counselor/diaries/${ids[0]}`, pageToken)).status).toBe(
      404,
    );
    const pageTwo = await get(
      `/counselor/diaries?limit=1&cursor=${first.nextCursor}`,
      pageToken,
    );
    expect(pageTwo.status).toBe(200);
    const second = pageTwo.body as {
      entries: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(second.entries.map((row) => row.id)).toEqual([ids[2]]);
    expect(second.nextCursor).not.toBeNull();
    const pageThree = await get(
      `/counselor/diaries?limit=1&cursor=${second.nextCursor}`,
      pageToken,
    );
    expect(pageThree.status).toBe(200);
    const third = pageThree.body as {
      entries: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(third.entries.map((row) => row.id)).toEqual([ids[3]]);
    expect(third.nextCursor).toBeNull();
    expect(
      [...first.entries, ...second.entries, ...third.entries].map(
        (row) => row.id,
      ),
    ).toEqual([ids[0], ids[2], ids[3]]);
  });

  it('returns 400 for malformed cursor payloads', async () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const invalid = [
      Buffer.from('{').toString('base64url'),
      encode({}),
      encode([]),
      encode(['2024-01-01T00:00:00.000Z']),
      encode([null, randomUUID()]),
      encode(['not-a-date', randomUUID()]),
      encode(['2024-02-30T00:00:00.000Z', randomUUID()]),
      encode(['2024-01-01T00:00:00.000Z', 'not-a-uuid']),
      encode(['2024-01-01T00:00:00.000Z', randomUUID(), 'extra']),
      'a'.repeat(257),
    ];
    for (const cursor of invalid)
      expect((await get(`/counselor/diaries?cursor=${cursor}`)).status).toBe(
        400,
      );
  });
  it('removes access on the next request after relationship revocation', async () => {
    const journal = await entry();
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(200);
    const revoked = await request(server())
      .patch(`/relationships/${relationId}/revoke`)
      .set('Authorization', auth(token));
    expect(revoked.status).toBe(200);
    expect((await get(`/counselor/diaries/${journal.id}`)).status).toBe(404);
    const list = await get('/counselor/diaries');
    expect(
      (list.body as { entries: Array<{ id: string }> }).entries.map(
        (item) => item.id,
      ),
    ).not.toContain(journal.id);
  });
});
