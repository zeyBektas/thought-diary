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

type Identity = { id: string; token: string };
type Sharing = {
  shareVersion: string;
  recipients: { relationshipId: string }[];
};

describe('isolated organization lifecycle and scoped authorization', () => {
  let app: INestApplication;
  let db: PrismaService;
  let admin: Identity;
  const roles = new Map<RoleCode, string>();

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
    for (const code of [
      RoleCode.ADMIN,
      RoleCode.PLATFORM_ADMIN,
      RoleCode.CLIENT,
      RoleCode.COUNSELOR,
    ]) {
      const role = await db.role.upsert({
        where: { code },
        update: {},
        create: { code },
      });
      roles.set(code, role.id);
    }
    admin = await user(RoleCode.PLATFORM_ADMIN);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const http = () => request(app.getHttpServer() as Server);
  const auth = (identity: Identity) =>
    ['Authorization', `Bearer ${identity.token}`] as const;
  const org = (id: string) => `/organizations/${id}`;
  const adminOrg = (id: string) => `/admin/organizations/${id}`;
  const decision = { reason: 'Isolated lifecycle fixture' };

  async function user(code: RoleCode): Promise<Identity> {
    const roleId = roles.get(code)!;
    const { id } = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        firstName: 'Synthetic',
        lastName: 'Fixture',
        passwordHash: 'fixture',
        roleId,
        roleAssignments: { create: { roleId } },
      },
    });
    // A privileged legacy claim must never override current assignments.
    return {
      id,
      token: app
        .get(JwtService)
        .sign({ sub: id, role: RoleCode.PLATFORM_ADMIN }),
    };
  }

  async function organization() {
    const response = await http()
      .post('/admin/organizations')
      .set(...auth(admin))
      .send({ name: `Synthetic ${randomUUID()}` })
      .expect(201);
    return (response.body as { id: string }).id;
  }

  function admit(organizationId: string, member: Identity) {
    return http()
      .post(`${adminOrg(organizationId)}/memberships`)
      .set(...auth(admin))
      .send({ userId: member.id });
  }

  async function membership(organizationId: string, member: Identity) {
    const response = await admit(organizationId, member).expect(201);
    return (response.body as { id: string }).id;
  }

  function permission(
    organizationId: string,
    membershipId: string,
    actor: Identity,
    value: 'ORG_ADMIN' | 'MEMBER',
  ) {
    return http()
      .patch(
        `${adminOrg(organizationId)}/memberships/${membershipId}/permission`,
      )
      .set(...auth(actor))
      .send({ permission: value });
  }

  function lifecycle(
    organizationId: string,
    action: 'suspend' | 'reactivate',
    actor = admin,
  ) {
    return http()
      .post(`${adminOrg(organizationId)}/${action}`)
      .set(...auth(actor))
      .send(decision);
  }

  function membershipAction(
    organizationId: string,
    membershipId: string,
    action: 'suspend' | 'remove',
    actor = admin,
  ) {
    return http()
      .post(`${org(organizationId)}/memberships/${membershipId}/${action}`)
      .set(...auth(actor))
      .send(decision);
  }

  async function fixture() {
    const client = await user(RoleCode.CLIENT);
    const counselor = await user(RoleCode.COUNSELOR);
    await db.counselorProfile.create({
      data: { userId: counselor.id, approvalStatus: 'APPROVED' },
    });
    const organizationId = await organization();
    const clientMembership = await membership(organizationId, client);
    const counselorMembership = await membership(organizationId, counselor);
    async function createRelationship(organizationId: string | null) {
      return db.careRelationship.create({
        data: {
          clientId: client.id,
          counselorId: counselor.id,
          organizationId,
          status: 'ACTIVE',
        },
      });
    }
    const scoped = await createRelationship(organizationId);
    const independent = await createRelationship(null);
    const otherOrganizationId = await organization();
    await membership(otherOrganizationId, client);
    await membership(otherOrganizationId, counselor);
    const other = await createRelationship(otherOrganizationId);
    const journal = await db.journal.create({
      data: {
        userId: client.id,
        entryType: 'FREE_JOURNAL',
        visibility: 'COUNSELOR',
        content: { text: 'Synthetic organization fixture' },
        shares: {
          create: [scoped, independent, other].map(({ id }) => ({
            relationshipId: id,
          })),
        },
      },
    });
    return {
      organizationId,
      client,
      counselor,
      clientMembership,
      counselorMembership,
      scoped,
      independent,
      other,
      otherOrganizationId,
      journal,
    };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function readSharing({ client, journal }: Fixture) {
    const response = await http()
      .get(`/diaries/${journal.id}/shares`)
      .set(...auth(client))
      .expect(200);
    return response.body as Sharing;
  }
  const recipients = (shares: Sharing) =>
    shares.recipients.map(({ relationshipId }) => relationshipId).sort();
  const replace = (
    { client, journal }: Fixture,
    shareVersion: string,
    recipientRelationshipIds: string[],
  ) =>
    http()
      .put(`/diaries/${journal.id}/shares`)
      .set(...auth(client))
      .send({ shareVersion, recipientRelationshipIds });
  const relationshipStatus = async (id: string) =>
    (await db.careRelationship.findUniqueOrThrow({ where: { id } })).status;

  it('isolates organization administration from platform authority and diary access', async () => {
    const f = await fixture();
    const legacy = await user(RoleCode.ADMIN);
    const orgAdmin = await user(RoleCode.CLIENT);
    const membershipId = await membership(f.organizationId, orgAdmin);
    await permission(
      f.organizationId,
      membershipId,
      orgAdmin,
      'ORG_ADMIN',
    ).expect(403);
    await permission(f.organizationId, membershipId, admin, 'ORG_ADMIN').expect(
      200,
    );
    for (const actor of [legacy, f.client, orgAdmin]) {
      await http()
        .post('/admin/organizations')
        .set(...auth(actor))
        .send({ name: 'Unauthorized' })
        .expect(403);
      await lifecycle(f.organizationId, 'suspend', actor).expect(403);
    }
    await http()
      .get('/admin/organizations')
      .set(...auth(admin))
      .expect(200);
    await http()
      .get(adminOrg(f.organizationId))
      .set(...auth(admin))
      .expect(200);
    await http()
      .get(org(f.organizationId))
      .set(...auth(orgAdmin))
      .expect(200);
    await http()
      .get(`${org(f.organizationId)}/memberships`)
      .set(...auth(orgAdmin))
      .expect(200);
    await http()
      .get(`${org(f.otherOrganizationId)}/memberships`)
      .set(...auth(orgAdmin))
      .expect(403);
    await http()
      .get(`${org(f.organizationId)}/memberships/${membershipId}`)
      .set(...auth(orgAdmin))
      .expect(200);
    await permission(
      f.organizationId,
      f.clientMembership,
      orgAdmin,
      'ORG_ADMIN',
    ).expect(403);
    await permission(f.organizationId, membershipId, orgAdmin, 'MEMBER').expect(
      403,
    );
    await http()
      .get(`/diaries/${f.journal.id}`)
      .set(...auth(orgAdmin))
      .expect(404);
    await http()
      .get(`/diaries/${f.journal.id}/shares`)
      .set(...auth(orgAdmin))
      .expect(404);
    await http()
      .get(`/counselor/diaries/${f.journal.id}`)
      .set(...auth(orgAdmin))
      .expect(404);
    await permission(f.organizationId, membershipId, admin, 'MEMBER').expect(
      200,
    );
    await http()
      .get(org(f.organizationId))
      .set(...auth(orgAdmin))
      .expect(200);
    await http()
      .get(`${org(f.organizationId)}/memberships`)
      .set(...auth(orgAdmin))
      .expect(403);
    const history = await http()
      .get(`${adminOrg(f.organizationId)}/memberships/${membershipId}/history`)
      .set(...auth(admin))
      .expect(200);
    expect(
      (history.body as { action: string }[]).map(({ action }) => action),
    ).toEqual(
      expect.arrayContaining([
        'ORGANIZATION_ADMIN_ASSIGNED',
        'ORGANIZATION_ADMIN_REVOKED',
      ]),
    );
    const formerAdmin = await user(RoleCode.PLATFORM_ADMIN);
    await lifecycle(f.organizationId, 'suspend', formerAdmin).expect(200);
    await db.userRole.updateMany({
      where: { userId: formerAdmin.id },
      data: { revokedAt: new Date() },
    });
    await lifecycle(f.organizationId, 'reactivate', formerAdmin).expect(403);
    await lifecycle(f.organizationId, 'reactivate').expect(200);
  });

  it.each(['suspend', 'leave', 'remove'] as const)(
    'preserves membership history and scope on %s',
    async (action) => {
      const f = await fixture();
      const before = await readSharing(f);
      const list = await http()
        .get('/organizations/memberships/me')
        .set(...auth(f.client))
        .expect(200);
      expect(list.body).toHaveLength(2);
      await admit(f.organizationId, f.client).expect(409);
      if (action === 'leave') {
        await http()
          .post(`${org(f.organizationId)}/memberships/me/leave`)
          .set(...auth(f.client))
          .expect(200);
      } else {
        await membershipAction(
          f.organizationId,
          f.clientMembership,
          action,
        ).expect(200);
      }
      await http()
        .get(org(f.organizationId))
        .set(...auth(f.client))
        .expect(403);
      await http()
        .get(org(f.otherOrganizationId))
        .set(...auth(f.client))
        .expect(200);
      await permission(
        f.organizationId,
        f.clientMembership,
        admin,
        'ORG_ADMIN',
      ).expect(409);
      expect(await relationshipStatus(f.scoped.id)).toBe('REVOKED');
      expect(await relationshipStatus(f.independent.id)).toBe('ACTIVE');
      expect(await relationshipStatus(f.other.id)).toBe('ACTIVE');
      const surviving = [f.independent.id, f.other.id].sort();
      const updated = await readSharing(f);
      expect(recipients(updated)).toEqual(surviving);
      await replace(f, before.shareVersion, surviving).expect(409);
      if (action === 'suspend') {
        await admit(f.organizationId, f.client).expect(409);
        await membershipAction(
          f.organizationId,
          f.clientMembership,
          'remove',
        ).expect(200);
      }
      expect(await membership(f.organizationId, f.client)).not.toBe(
        f.clientMembership,
      );
      expect(await readSharing(f)).toEqual(updated);
      const old = await db.organizationMembership.findUniqueOrThrow({
        where: { id: f.clientMembership },
      });
      expect(old.status).toBe(action === 'leave' ? 'LEFT' : 'REMOVED');
      await membershipAction(
        f.organizationId,
        f.clientMembership,
        'suspend',
      ).expect(409);
    },
  );

  it('supports independent and multiple scoped relationships without restoring grants on reconnect', async () => {
    const f = await fixture();
    const requestRelationship = (organizationId: string | null) =>
      http()
        .post('/relationships')
        .set(...auth(f.counselor))
        .send({ organizationId, clientId: f.client.id });
    for (const context of [null, f.organizationId, f.otherOrganizationId]) {
      await requestRelationship(context).expect(409);
    }
    await requestRelationship(await organization()).expect(403);
    await http()
      .patch(`/relationships/${f.scoped.id}/revoke`)
      .set(...auth(f.client))
      .expect(200);
    const fresh = await requestRelationship(f.organizationId).expect(201);
    const replacement = fresh.body as { id: string; organizationId: string };
    expect(replacement.id).not.toBe(f.scoped.id);
    expect(replacement.organizationId).toBe(f.organizationId);
    await http()
      .patch(`/relationships/${replacement.id}`)
      .set(...auth(f.client))
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(recipients(await readSharing(f))).toEqual(
      [f.independent.id, f.other.id].sort(),
    );
    expect(
      await db.careRelationship.findUniqueOrThrow({
        where: { id: f.independent.id },
      }),
    ).toEqual(f.independent);
  });

  it('suspends organization operations, retains episodes, and resumes without restoring grants', async () => {
    const f = await fixture();
    const dormant = await Promise.all([
      user(RoleCode.CLIENT),
      user(RoleCode.CLIENT),
      user(RoleCode.CLIENT),
    ]);
    const episodes = await Promise.all(
      dormant.map((member) => membership(f.organizationId, member)),
    );
    await membershipAction(f.organizationId, episodes[0], 'suspend').expect(
      200,
    );
    await membershipAction(f.organizationId, episodes[1], 'remove').expect(200);
    await http()
      .post(`${org(f.organizationId)}/memberships/me/leave`)
      .set(...auth(dormant[2]))
      .expect(200);
    await permission(
      f.organizationId,
      f.clientMembership,
      admin,
      'ORG_ADMIN',
    ).expect(200);
    const scopedOnly = await db.journal.create({
      data: {
        userId: f.client.id,
        entryType: 'FREE_JOURNAL',
        visibility: 'COUNSELOR',
        content: { text: 'Synthetic scoped-only fixture' },
        shares: { create: { relationshipId: f.scoped.id } },
      },
    });
    const detail = () =>
      http()
        .get(`/counselor/diaries/${scopedOnly.id}`)
        .set(...auth(f.counselor));
    await detail().expect(200);
    await lifecycle(f.organizationId, 'suspend').expect(200);
    await http()
      .get(`${org(f.organizationId)}/memberships`)
      .set(...auth(f.client))
      .expect(403);
    await http()
      .get(org(f.organizationId))
      .set(...auth(f.counselor))
      .expect(403);
    await http()
      .patch(`/relationships/${f.scoped.id}/revoke`)
      .set(...auth(f.client))
      .expect(403);
    const list = await http()
      .get('/relationships')
      .set(...auth(f.client))
      .expect(200);
    expect((list.body as { id: string }[]).map(({ id }) => id).sort()).toEqual(
      [f.independent.id, f.other.id].sort(),
    );
    await detail().expect(404);
    await http()
      .get(`/counselor/diaries/${f.journal.id}`)
      .set(...auth(f.counselor))
      .expect(200);
    const during = await readSharing(f);
    expect(recipients(during)).toEqual([f.independent.id, f.other.id].sort());
    await replace(f, during.shareVersion, [f.scoped.id]).expect(400);
    expect(await relationshipStatus(f.scoped.id)).toBe('ACTIVE');
    await lifecycle(f.organizationId, 'reactivate').expect(200);
    await http()
      .get(`${org(f.organizationId)}/memberships`)
      .set(...auth(f.client))
      .expect(200);
    for (const member of dormant)
      await http()
        .get(org(f.organizationId))
        .set(...auth(member))
        .expect(403);
    await detail().expect(404);
    expect(await readSharing(f)).toEqual(during);
    await replace(f, during.shareVersion, [
      f.scoped.id,
      f.independent.id,
      f.other.id,
    ]).expect(200);
    expect(recipients(await readSharing(f))).toContain(f.scoped.id);
    expect(
      await db.journal.findUniqueOrThrow({ where: { id: scopedOnly.id } }),
    ).toEqual(scopedOnly);
  });

  async function blockedBy(pid: number) {
    const deadline = performance.now() + 3_000;
    do {
      const [waiter] = await db.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND ${pid}::integer = ANY(pg_blocking_pids(pid))
      `;
      if (waiter) return waiter.pid;
      await delay(10);
    } while (performance.now() < deadline);
    throw new Error('Expected a database transaction to wait for the lock');
  }

  async function race(
    mutation: 'INSERT' | 'DELETE',
    first: () => request.Test,
    second: () => request.Test,
  ) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE FUNCTION integration_organization_grant_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(84011932);
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END;
      $$`;
      const operation =
        mutation === 'INSERT' ? Prisma.sql`INSERT` : Prisma.sql`DELETE`;
      await tx.$executeRaw`CREATE TRIGGER integration_organization_grant_gate
        BEFORE ${operation} ON journal_shares
        FOR EACH ROW EXECUTE FUNCTION integration_organization_grant_gate()`;
    });
    const requests: Promise<request.Response>[] = [];
    function start(call: () => request.Test) {
      const pending = call().then((response) => response);
      requests.push(pending);
      void pending.catch(() => undefined);
    }
    try {
      await db.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid FROM (SELECT pg_advisory_xact_lock(84011932)) gate
        `;
          start(first);
          const firstPid = await blockedBy(pid);
          start(second);
          await blockedBy(firstPid);
        },
        { timeout: 10_000 },
      );
      return await Promise.all(requests);
    } finally {
      await Promise.allSettled(requests);
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`DROP TRIGGER integration_organization_grant_gate ON journal_shares`;
        await tx.$executeRaw`DROP FUNCTION integration_organization_grant_gate()`;
      });
    }
  }

  function transition(f: Fixture, action: 'organization' | 'membership') {
    return action === 'organization'
      ? lifecycle(f.organizationId, 'suspend')
      : membershipAction(f.organizationId, f.counselorMembership, 'remove');
  }

  describe.each(['organization', 'membership'] as const)(
    '%s revocation transaction',
    (action) => {
      it.each([true, false])(
        'serializes sharing and lifecycle commits (sharing first: %s)',
        async (sharingFirst) => {
          const f = await fixture();
          const before = await readSharing(f);
          const shared = () =>
            replace(f, before.shareVersion, recipients(before));
          const revoke = () => transition(f, action);
          const results = sharingFirst
            ? await race('INSERT', shared, revoke)
            : await race('DELETE', revoke, shared);
          expect(results.map(({ status }) => status)).toEqual(
            sharingFirst ? [200, 200] : [200, 409],
          );
          if (!sharingFirst)
            expect(results[1].body).toMatchObject({
              message: 'Sharing has changed; reload and try again',
            });
          expect(
            await db.journalShare.count({
              where: { relationshipId: f.scoped.id },
            }),
          ).toBe(0);
          expect(await relationshipStatus(f.scoped.id)).toBe(
            action === 'organization' ? 'ACTIVE' : 'REVOKED',
          );
          const after = await readSharing(f);
          expect(after.shareVersion).not.toBe(before.shareVersion);
          expect(recipients(after)).toEqual(
            [f.independent.id, f.other.id].sort(),
          );
        },
      );

      it('rolls back the lifecycle and grant changes when required audit writing fails', async () => {
        const f = await fixture();
        const before = await readSharing(f);
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`CREATE FUNCTION integration_fail_organization_audit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.action IN ('ORGANIZATION_SUSPENDED', 'ORGANIZATION_MEMBERSHIP_REMOVED') THEN
              RAISE EXCEPTION 'Synthetic lifecycle audit failure';
            END IF;
            RETURN NEW;
          END;
        $$`;
          await tx.$executeRaw`CREATE CONSTRAINT TRIGGER integration_fail_organization_audit
          AFTER INSERT ON audit_logs DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION integration_fail_organization_audit()`;
        });
        try {
          await transition(f, action).expect(500);
        } finally {
          await db.$transaction(async (tx) => {
            await tx.$executeRaw`DROP TRIGGER integration_fail_organization_audit ON audit_logs`;
            await tx.$executeRaw`DROP FUNCTION integration_fail_organization_audit()`;
          });
        }
        expect(await readSharing(f)).toEqual(before);
        expect(await relationshipStatus(f.scoped.id)).toBe('ACTIVE');
        expect(
          await db.organization.findUniqueOrThrow({
            where: { id: f.organizationId },
          }),
        ).toMatchObject({ status: 'ACTIVE' });
        expect(
          await db.organizationMembership.findUniqueOrThrow({
            where: { id: f.counselorMembership },
          }),
        ).toMatchObject({ status: 'ACTIVE' });
        expect(
          await db.auditLog.count({
            where: {
              organizationId: f.organizationId,
              action: {
                in: [
                  'ORGANIZATION_SUSPENDED',
                  'ORGANIZATION_MEMBERSHIP_REMOVED',
                ],
              },
            },
          }),
        ).toBe(0);
      });
    },
  );
});
