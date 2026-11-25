import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, RoleCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

type Shares = {
  shareVersion: string;
  recipients: Array<{ relationshipId: string }>;
};

describe('isolated counselor suspension and diary grants', () => {
  let app: INestApplication;
  let db: PrismaService;
  let adminToken: string;
  let clientRoleId: string;
  let counselorRoleId: string;

  const server = () => app.getHttpServer() as Server;
  const bearer = (token: string) => `Bearer ${token}`;
  const tokenFor = (id: string) => app.get(JwtService).sign({ sub: id });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    db = app.get(PrismaService);
    const ensureRole = (code: RoleCode) =>
      db.role.upsert({ where: { code }, update: {}, create: { code } });
    clientRoleId = (await ensureRole(RoleCode.CLIENT)).id;
    counselorRoleId = (await ensureRole(RoleCode.COUNSELOR)).id;
    const platformAdmin = await ensureRole(RoleCode.PLATFORM_ADMIN);
    const admin = await createUser(platformAdmin.id);
    adminToken = tokenFor(admin.id);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function createUser(roleId: string) {
    return db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Synthetic',
        lastName: 'Fixture',
        passwordHash: 'fixture',
        roleId,
        roleAssignments: { create: { roleId } },
      },
    });
  }

  async function createCounselorRelationship(clientId: string) {
    const counselor = await createUser(counselorRoleId);
    const profile = await db.counselorProfile.create({
      data: { userId: counselor.id, approvalStatus: 'APPROVED' },
    });
    const relationship = await db.careRelationship.create({
      data: { clientId, counselorId: counselor.id, status: 'ACTIVE' },
    });
    return { counselor, profile, relationship };
  }

  async function createSharedDiary(clientId: string, relationshipId: string) {
    return db.journal.create({
      data: {
        userId: clientId,
        entryType: 'FREE_JOURNAL',
        visibility: 'COUNSELOR',
        content: { text: 'Synthetic diary' },
        shares: { create: { relationshipId } },
      },
    });
  }

  async function fixture() {
    const client = await createUser(clientRoleId);
    const { counselor, profile, relationship } =
      await createCounselorRelationship(client.id);
    return {
      client,
      clientToken: tokenFor(client.id),
      counselorToken: tokenFor(counselor.id),
      profile,
      relationship,
      journal: await createSharedDiary(client.id, relationship.id),
    };
  }

  async function getShares(journalId: string, token: string) {
    const response = await request(server())
      .get(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(token));
    expect(response.status).toBe(200);
    return response.body as Shares;
  }

  function replaceShares(
    journalId: string,
    token: string,
    shareVersion: string,
    recipientRelationshipIds: string[],
  ) {
    return request(server())
      .put(`/diaries/${journalId}/shares`)
      .set('Authorization', bearer(token))
      .send({ shareVersion, recipientRelationshipIds });
  }

  function counselorAction(profileId: string, action: 'suspend' | 'reinstate') {
    return request(server())
      .post(`/admin/counselors/${profileId}/${action}`)
      .set('Authorization', bearer(adminToken))
      .send({ reason: 'Isolated professional review fixture' });
  }

  function getCounselorDiary(journalId: string, token: string) {
    return request(server())
      .get(`/counselor/diaries/${journalId}`)
      .set('Authorization', bearer(token));
  }

  async function expectNoGrants(relationshipId: string) {
    expect(await db.journalShare.count({ where: { relationshipId } })).toBe(0);
  }

  it('revokes only the suspended counselor’s grants and requires explicit resharing after reinstatement', async () => {
    const {
      client,
      clientToken,
      counselorToken,
      profile,
      relationship,
      journal,
    } = await fixture();
    const other = await createCounselorRelationship(client.id);
    const otherGrant = await db.journalShare.create({
      data: { journalId: journal.id, relationshipId: other.relationship.id },
    });
    const secondDiary = await createSharedDiary(client.id, relationship.id);
    const before = await getShares(journal.id, clientToken);
    expect(before.recipients).toHaveLength(2);
    expect((await getCounselorDiary(journal.id, counselorToken)).status).toBe(
      200,
    );

    expect((await counselorAction(profile.id, 'suspend')).status).toBe(200);
    await expectNoGrants(relationship.id);
    expect(
      await db.careRelationship.findUniqueOrThrow({
        where: { id: relationship.id },
      }),
    ).toEqual(relationship);
    expect(
      await db.journal.findUniqueOrThrow({ where: { id: journal.id } }),
    ).toEqual(journal);
    expect(
      await db.journal.findUniqueOrThrow({ where: { id: secondDiary.id } }),
    ).toEqual(secondDiary);
    expect(
      await db.journalShare.findUniqueOrThrow({ where: { id: otherGrant.id } }),
    ).toEqual(otherGrant);
    expect((await getCounselorDiary(journal.id, counselorToken)).status).toBe(
      404,
    );
    const suspended = await getShares(journal.id, clientToken);
    expect(
      suspended.recipients.map(({ relationshipId }) => relationshipId),
    ).toEqual([other.relationship.id]);
    expect(suspended.shareVersion).not.toBe(before.shareVersion);

    const both = [relationship.id, other.relationship.id];
    expect(
      (await replaceShares(journal.id, clientToken, before.shareVersion, both))
        .status,
    ).toBe(409);
    expect(
      (
        await replaceShares(
          journal.id,
          clientToken,
          suspended.shareVersion,
          both,
        )
      ).status,
    ).toBe(400);
    expect(await getShares(journal.id, clientToken)).toEqual(suspended);

    expect((await counselorAction(profile.id, 'reinstate')).status).toBe(200);
    await expectNoGrants(relationship.id);
    expect(await getShares(journal.id, clientToken)).toEqual(suspended);
    expect((await getCounselorDiary(journal.id, counselorToken)).status).toBe(
      404,
    );
    expect(
      (
        await replaceShares(
          journal.id,
          clientToken,
          suspended.shareVersion,
          both,
        )
      ).status,
    ).toBe(200);
    expect((await getCounselorDiary(journal.id, counselorToken)).status).toBe(
      200,
    );
    expect(
      (await getCounselorDiary(secondDiary.id, counselorToken)).status,
    ).toBe(404);
  });

  async function waitForBlockedBackend(blockingPid: number) {
    const deadline = performance.now() + 3_000;
    do {
      const [blocked] = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND ${blockingPid}::integer = ANY(pg_blocking_pids(pid))
      `;
      if (blocked) return blocked.pid;
      await delay(10);
    } while (performance.now() < deadline);
    throw new Error('Expected a database transaction to wait for the lock');
  }

  async function raceWithGrantLock(
    grantMutation: 'INSERT' | 'DELETE',
    first: () => request.Test,
    second: () => request.Test,
  ) {
    await db.$transaction(async (tx) => {
      // The per-test transaction acquires this advisory lock before issuing
      // either HTTP request. The trigger keeps the first writer in its real
      // transaction with its row locks held until the second writer joins.
      await tx.$executeRaw`CREATE FUNCTION integration_wait_on_grant() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(84011931);
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END;
      $$`;
      await tx.$executeRaw(Prisma.sql`CREATE TRIGGER integration_wait_on_grant
        BEFORE ${Prisma.raw(grantMutation)} ON journal_shares
        FOR EACH ROW EXECUTE FUNCTION integration_wait_on_grant()`);
    });
    const requests: Array<Promise<request.Response>> = [];
    function start(operation: () => request.Test) {
      const pending = operation().then((response) => response);
      requests.push(pending);
      void pending.catch(() => undefined);
    }
    try {
      await db.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS pid
            FROM (SELECT pg_advisory_xact_lock(84011931)) AS gate
          `;
          start(first);
          const firstPid = await waitForBlockedBackend(pid);
          start(second);
          await waitForBlockedBackend(firstPid);
        },
        { timeout: 10_000 },
      );
      return await Promise.all(requests);
    } finally {
      await Promise.allSettled(requests);
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`DROP TRIGGER integration_wait_on_grant ON journal_shares`;
        await tx.$executeRaw`DROP FUNCTION integration_wait_on_grant()`;
      });
    }
  }

  it('removes the replacement grant when sharing commits before the waiting suspension', async () => {
    const { clientToken, profile, relationship, journal } = await fixture();
    const before = await getShares(journal.id, clientToken);
    const [sharing, suspension] = await raceWithGrantLock(
      'INSERT',
      () =>
        replaceShares(journal.id, clientToken, before.shareVersion, [
          relationship.id,
        ]),
      () => counselorAction(profile.id, 'suspend'),
    );
    expect(sharing.status).toBe(200);
    expect(suspension.status).toBe(200);
    await expectNoGrants(relationship.id);
    expect((await getShares(journal.id, clientToken)).recipients).toEqual([]);
  });

  it('rejects the waiting replacement with a stale-version conflict when suspension commits first', async () => {
    const { clientToken, profile, relationship, journal } = await fixture();
    const before = await getShares(journal.id, clientToken);
    const [suspension, sharing] = await raceWithGrantLock(
      'DELETE',
      () => counselorAction(profile.id, 'suspend'),
      () =>
        replaceShares(journal.id, clientToken, before.shareVersion, [
          relationship.id,
        ]),
    );
    expect(suspension.status).toBe(200);
    expect(sharing.status).toBe(409);
    await expectNoGrants(relationship.id);
    expect((await getShares(journal.id, clientToken)).shareVersion).not.toBe(
      before.shareVersion,
    );
  });

  it('rolls back approval, grants, and audit if the suspension transaction fails at commit', async () => {
    const { clientToken, profile, relationship, journal } = await fixture();
    const before = await getShares(journal.id, clientToken);
    const grants = await db.journalShare.findMany({
      where: { relationshipId: relationship.id },
    });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE SEQUENCE integration_suspension_failure`;
      await tx.$executeRaw`CREATE FUNCTION integration_fail_suspension_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'COUNSELOR_SUSPENDED' AND EXISTS (
            SELECT 1 FROM counselor_profiles p
            WHERE p.id = NEW."targetId" AND p."approvalStatus" = 'SUSPENDED'
              AND NOT EXISTS (
                SELECT 1 FROM journal_shares s
                JOIN care_relationships r ON r.id = s."relationshipId"
                WHERE r."counselorId" = p."userId"
              )
          ) THEN
            PERFORM nextval('integration_suspension_failure');
            RAISE EXCEPTION 'integration suspension audit failure';
          END IF;
          RETURN NEW;
        END;
      $$`;
      await tx.$executeRaw`CREATE CONSTRAINT TRIGGER integration_fail_suspension_audit
        AFTER INSERT ON audit_logs DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION integration_fail_suspension_audit()`;
    });
    try {
      expect((await counselorAction(profile.id, 'suspend')).status).toBe(500);
      // Sequence changes survive a failed transaction, proving the check
      // observed the profile update and grant deletion before the rollback.
      expect(
        await db.$queryRaw`SELECT is_called FROM integration_suspension_failure`,
      ).toEqual([{ is_called: true }]);
    } finally {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`DROP TRIGGER integration_fail_suspension_audit ON audit_logs`;
        await tx.$executeRaw`DROP FUNCTION integration_fail_suspension_audit()`;
        await tx.$executeRaw`DROP SEQUENCE integration_suspension_failure`;
      });
    }
    expect(
      await db.counselorProfile.findUniqueOrThrow({
        where: { id: profile.id },
      }),
    ).toEqual(profile);
    expect(
      await db.journalShare.findMany({
        where: { relationshipId: relationship.id },
      }),
    ).toEqual(grants);
    expect(await getShares(journal.id, clientToken)).toEqual(before);
    expect(await db.auditLog.count({ where: { targetId: profile.id } })).toBe(
      0,
    );
  });
});
