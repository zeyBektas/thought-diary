import {
  MailDelivery,
  type MailMessage,
} from '@/core/mail/mail-delivery.module';
import { PrismaService } from '@/core/prisma/prisma.service';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { RoleCode } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';

type Actor = { id: string; email: string; access: string };
type Invitation = {
  id: string;
  expiresAt: string;
  email: string;
  status: string;
};

class TestMail extends MailDelivery {
  messages: MailMessage[] = [];
  fail = false;
  gate?: () => Promise<void>;

  async send(message: MailMessage) {
    await this.gate?.();
    if (this.fail) throw new Error('Synthetic provider error');
    this.messages.push(message);
  }

  take(purpose: MailMessage['purpose'], to: string) {
    const index = this.messages.findIndex(
      (message) => message.purpose === purpose && message.to === to,
    );
    if (index < 0) throw new Error('Expected a synthetic delivery');
    return this.messages.splice(index, 1)[0];
  }
}

describe('isolated organization invitations and verified email', () => {
  let app: INestApplication;
  let db: PrismaService;
  let admin: Actor;
  const mail = new TestMail();
  const roles = new Map<RoleCode, string>();
  const http = () => request(app.getHttpServer() as Server);
  const auth = (actor: Actor) =>
    ['Authorization', `Bearer ${actor.access}`] as const;
  const address = () => `${randomUUID()}@example.test`;
  const path = (org: string) => `/organizations/${org}/invitations`;
  const hash = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const scope = (org: string, actor: Actor) => ({
    organizationId: org,
    userId: actor.id,
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailDelivery)
      .useValue(mail)
      .compile();
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
    for (const code of Object.values(RoleCode)) {
      const role = await db.role.upsert({
        where: { code },
        create: { code },
        update: {},
      });
      roles.set(code, role.id);
    }
    admin = await actor('PLATFORM_ADMIN');
  });

  afterEach(() => {
    mail.messages = [];
    mail.fail = false;
    mail.gate = undefined;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function actor(
    code: RoleCode = 'CLIENT',
    verified = true,
  ): Promise<Actor> {
    const roleId = roles.get(code)!;
    const user = await db.user.create({
      data: {
        email: address(),
        firstName: 'Synthetic',
        lastName: 'Fixture',
        passwordHash: 'fixture',
        emailVerifiedAt: verified ? new Date() : null,
        roleId,
        roleAssignments: { create: { roleId } },
      },
    });
    return {
      id: user.id,
      email: user.email,
      access: app
        .get(JwtService)
        .sign({ sub: user.id, role: 'PLATFORM_ADMIN' }),
    };
  }

  async function organization() {
    return (await db.organization.create({ data: { name: randomUUID() } })).id;
  }

  function create(
    org: string,
    email: string,
    type: 'CLIENT' | 'COUNSELOR' = 'CLIENT',
    by = admin,
  ) {
    return http()
      .post(path(org))
      .set(...auth(by))
      .send({ email, type });
  }

  async function invite(
    org: string,
    email: string,
    type: 'CLIENT' | 'COUNSELOR' = 'CLIENT',
    by = admin,
  ) {
    const response = await create(org, email, type, by).expect(201);
    const normalized = email.trim().toLowerCase();
    const delivery = mail.take('ORGANIZATION_INVITATION', normalized);
    expect(response.body).not.toHaveProperty('token');
    expect(response.body).not.toHaveProperty('tokenHash');
    expect(response.text.includes(delivery.token)).toBe(false);
    return { ...(response.body as Invitation), token: delivery.token };
  }

  function change(
    org: string,
    id: string,
    action: 'resend' | 'revoke',
    by = admin,
  ) {
    return http()
      .post(`${path(org)}/${id}/${action}`)
      .set(...auth(by));
  }

  function accept(by: Actor, token: string) {
    return http()
      .post('/organizations/invitations/accept')
      .set(...auth(by))
      .send({ token });
  }

  async function invalid(by: Actor, token: string) {
    const response = await accept(by, token).expect(400);
    expect(response.body).toEqual({
      message: 'Invitation is not valid',
      error: 'Bad Request',
      statusCode: 400,
    });
  }

  async function persistMembership(
    org: string,
    by: Actor,
    permission: 'MEMBER' | 'ORG_ADMIN' = 'MEMBER',
  ) {
    return db.organizationMembership.create({
      data: { ...scope(org, by), acceptedAt: new Date(), permission },
    });
  }

  it('uses current organization authority, not legacy role or JWT claims', async () => {
    const org = await organization();
    const other = await organization();
    const ordinary = await actor();
    const legacy = await actor('ADMIN');
    const scoped = await actor();
    await persistMembership(org, ordinary);
    const scopedMembership = await persistMembership(org, scoped, 'ORG_ADMIN');
    await create(org, address(), 'CLIENT', ordinary).expect(403);
    await create(org, address(), 'CLIENT', legacy).expect(403);
    await create(other, address(), 'CLIENT', scoped).expect(403);
    const invitation = await invite(org, address(), 'CLIENT', scoped);
    const otherInvitation = await invite(other, address());
    await http()
      .get(`${path(org)}/${otherInvitation.id}`)
      .set(...auth(scoped))
      .expect(404);
    await http()
      .get(path(other))
      .set(...auth(scoped))
      .expect(403);
    await http()
      .get(path(org))
      .set(...auth(scoped))
      .expect(200);
    await http()
      .get(`${path(org)}/${invitation.id}`)
      .expect(401);
    await db.organizationMembership.update({
      where: { id: scopedMembership.id },
      data: { status: 'SUSPENDED' },
    });
    await change(org, invitation.id, 'revoke', scoped).expect(403);
    const former = await actor('PLATFORM_ADMIN');
    await db.userRole.updateMany({
      where: { userId: former.id },
      data: { revokedAt: new Date() },
    });
    await create(org, address(), 'CLIENT', former).expect(403);
  });

  it('stores only a SHA-256 hash and consumes a 256-bit token once for the matching verified account', async () => {
    const org = await organization();
    const by = await actor();
    const invitation = await invite(org, ` ${by.email.toUpperCase()} `);
    expect(invitation.email).toBe(by.email);
    expect(Buffer.from(invitation.token, 'base64url')).toHaveLength(32);
    const saved = await db.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(saved.tokenHash === hash(invitation.token)).toBe(true);
    expect(saved.expiresAt.getTime() - saved.createdAt.getTime()).toBe(
      604_800_000,
    );
    expect(
      await db.organizationMembership.count({ where: scope(org, by) }),
    ).toBe(0);
    await invalid(by, 'invalid');
    await invalid(await actor(), invitation.token);
    await http().post('/organizations/invitations/accept').send({}).expect(401);
    const response = await accept(by, invitation.token).expect(200);
    expect(response.body).toMatchObject({
      membership: {
        organizationId: org,
        status: 'ACTIVE',
        permission: 'MEMBER',
      },
    });
    expect(response.text.includes(invitation.token)).toBe(false);
    await invalid(by, invitation.token);
    const after = await db.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(after).toMatchObject({
      status: 'ACCEPTED',
      invitedUserId: by.id,
      acceptedAt: expect.any(Date) as Date,
    });
    const audits = await db.auditLog.findMany({
      where: { targetId: invitation.id },
    });
    expect(audits.map(({ action }) => action).sort()).toEqual([
      'ORGANIZATION_INVITATION_ACCEPTANCE_DENIED',
      'ORGANIZATION_INVITATION_ACCEPTED',
      'ORGANIZATION_INVITATION_CREATED',
    ]);
    expect(JSON.stringify(audits).includes(invitation.token)).toBe(false);
    expect(JSON.stringify(audits).includes(saved.tokenHash)).toBe(false);
    expect(
      await db.careRelationship.count({ where: { clientId: by.id } }),
    ).toBe(0);
    expect(
      await db.journalShare.count({ where: { journal: { userId: by.id } } }),
    ).toBe(0);
  });

  it('rotates tokens without extending expiry, rejects terminal tokens, and releases expired pending uniqueness', async () => {
    const org = await organization();
    const by = await actor();
    const original = await invite(org, by.email);
    await create(org, by.email.toUpperCase()).expect(409);
    const response = await change(org, original.id, 'resend').expect(200);
    const rotated = mail.take('ORGANIZATION_INVITATION', by.email);
    expect(response.body).toMatchObject({
      id: original.id,
      expiresAt: original.expiresAt,
      email: original.email,
    });
    expect(response.text.includes(rotated.token)).toBe(false);
    expect(rotated.token === original.token).toBe(false);
    await invalid(by, original.token);
    await change(org, original.id, 'revoke').expect(200);
    await change(org, original.id, 'resend').expect(409);
    await invalid(by, rotated.token);
    const expiring = await invite(org, by.email);
    await db.organizationInvitation.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(0) },
    });
    const replacement = await invite(org, by.email);
    await invalid(by, expiring.token);
    await change(org, expiring.id, 'resend').expect(409);
    const detail = await http()
      .get(`${path(org)}/${expiring.id}`)
      .set(...auth(admin))
      .expect(200);
    expect(detail.body).toMatchObject({ status: 'EXPIRED' });
    expect(
      await db.auditLog.count({
        where: {
          targetId: expiring.id,
          action: 'ORGANIZATION_INVITATION_EXPIRED',
        },
      }),
    ).toBe(1);
    await accept(by, replacement.token).expect(200);
    await change(org, replacement.id, 'resend').expect(409);
  });

  it('requires registration, authentication and a separate account-bound email challenge', async () => {
    const org = await organization();
    const email = address();
    const invitation = await invite(org, email);
    expect(await db.user.count({ where: { email } })).toBe(0);
    const reg = await http()
      .post('/auth/register')
      .send({
        email,
        firstName: 'Synthetic',
        lastName: 'New',
        password: 'synthetic-password',
      })
      .expect(201);
    const { user, accessToken } = reg.body as {
      user: { id: string };
      accessToken: string;
    };
    const by = { id: user.id, email, access: accessToken };
    await invalid(by, invitation.token);
    expect(
      await db.organizationMembership.count({ where: scope(org, by) }),
    ).toBe(0);
    await http().post('/auth/email-verification/request').expect(401);
    await http()
      .post('/auth/email-verification/request')
      .set(...auth(by))
      .send({ email: address() })
      .expect(202);
    const challenge = mail.take('EMAIL_VERIFICATION', email);
    const stored = await db.emailVerificationChallenge.findUniqueOrThrow({
      where: { userId: by.id },
    });
    expect(stored.tokenHash === hash(challenge.token)).toBe(true);
    const confirm = (account: Actor, token: string) =>
      http()
        .post('/auth/email-verification/confirm')
        .set(...auth(account))
        .send({ token });
    await confirm(await actor('CLIENT', false), challenge.token).expect(400);
    await confirm(by, invitation.token).expect(400);
    await http()
      .post('/auth/email-verification/request')
      .set(...auth(by))
      .expect(429);
    await confirm(by, challenge.token).expect(200);
    await confirm(by, challenge.token).expect(400);
    await accept(by, invitation.token).expect(200);
  });

  it('rolls back failed verification delivery and rejects expired or rotated challenges', async () => {
    const by = await actor('CLIENT', false);
    const requestVerification = () =>
      http()
        .post('/auth/email-verification/request')
        .set(...auth(by));
    const confirm = (token: string) =>
      http()
        .post('/auth/email-verification/confirm')
        .set(...auth(by))
        .send({ token });
    mail.fail = true;
    await requestVerification().expect(503);
    expect(
      await db.emailVerificationChallenge.count({ where: { userId: by.id } }),
    ).toBe(0);
    mail.fail = false;
    await requestVerification().expect(202);
    const old = mail.take('EMAIL_VERIFICATION', by.email);
    await db.emailVerificationChallenge.update({
      where: { userId: by.id },
      data: { issuedAt: new Date(0), expiresAt: new Date(0) },
    });
    await confirm(old.token).expect(400);
    await requestVerification().expect(202);
    const fresh = mail.take('EMAIL_VERIFICATION', by.email);
    await confirm(old.token).expect(400);
    await confirm(fresh.token).expect(200);
    await requestVerification().expect(202, { verified: true });
    expect(mail.messages).toHaveLength(0);
  });

  it('does not choose between legacy accounts with the same normalized email', async () => {
    const org = await organization();
    const by = await actor();
    const duplicate = await actor();
    await db.user.update({
      where: { id: duplicate.id },
      data: { email: by.email.toUpperCase() },
    });
    const invitation = await invite(org, by.email);
    await invalid(by, invitation.token);
    await invalid(duplicate, invitation.token);
    expect(
      await db.organizationMembership.count({ where: { organizationId: org } }),
    ).toBe(0);
  });

  it.each([
    { status: 'SUSPENDED' },
    { status: 'INACTIVE' },
    { deletedAt: new Date() },
  ] as const)(
    'rejects acceptance with an ineligible account: %j',
    async (data) => {
      const org = await organization();
      const by = await actor();
      const invitation = await invite(org, by.email);
      await db.user.update({ where: { id: by.id }, data });
      await accept(by, invitation.token).expect(401);
      expect(
        await db.organizationMembership.count({ where: scope(org, by) }),
      ).toBe(0);
    },
  );

  it('blocks creation, resend, and acceptance while suspended; permits Platform Admin revocation', async () => {
    const org = await organization();
    const by = await actor();
    const invitation = await invite(org, by.email);
    await http()
      .post(`/admin/organizations/${org}/suspend`)
      .set(...auth(admin))
      .send({ reason: 'Synthetic review' })
      .expect(200);
    await create(org, address()).expect(403);
    await change(org, invitation.id, 'resend').expect(403);
    await invalid(by, invitation.token);
    await change(org, invitation.id, 'revoke').expect(200);
  });

  it('invites only currently eligible counselors and never grants or restores the counselor role', async () => {
    const org = await organization();
    const scoped = await actor();
    await persistMembership(org, scoped, 'ORG_ADMIN');
    const by = await actor('COUNSELOR');
    const profile = await db.counselorProfile.create({
      data: { userId: by.id },
    });
    for (const approvalStatus of [
      'PENDING',
      'REJECTED',
      'SUSPENDED',
    ] as const) {
      await db.counselorProfile.update({
        where: { id: profile.id },
        data: { approvalStatus },
      });
      await create(org, by.email, 'COUNSELOR', scoped).expect(409);
    }
    await create(org, address(), 'COUNSELOR').expect(409);
    await db.counselorProfile.update({
      where: { id: profile.id },
      data: { approvalStatus: 'APPROVED' },
    });
    const invitation = await invite(org, by.email, 'COUNSELOR', scoped);
    await db.counselorProfile.update({
      where: { id: profile.id },
      data: { approvalStatus: 'SUSPENDED' },
    });
    await invalid(by, invitation.token);
    await db.counselorProfile.update({
      where: { id: profile.id },
      data: { approvalStatus: 'APPROVED' },
    });
    const role = await db.userRole.findFirstOrThrow({
      where: { userId: by.id },
    });
    await db.userRole.update({
      where: { id: role.id },
      data: { revokedAt: new Date() },
    });
    await invalid(by, invitation.token);
    await change(org, invitation.id, 'resend').expect(409);
    expect(
      await db.organizationMembership.count({ where: scope(org, by) }),
    ).toBe(0);
    expect(await db.userRole.count({ where: { userId: by.id } })).toBe(1);
    await db.userRole.create({ data: { userId: by.id, roleId: role.roleId } });
    const response = await accept(by, invitation.token).expect(200);
    expect(response.body).toMatchObject({
      membership: { permission: 'MEMBER' },
    });
    expect(await db.userRole.count({ where: { userId: by.id } })).toBe(2);
  });

  it.each(['LEFT', 'REMOVED'] as const)(
    'preserves a %s episode, retains other roles and declines redundant invitations without consuming them',
    async (status) => {
      const org = await organization();
      const by = await actor('COUNSELOR');
      const existing = await persistMembership(org, by, 'ORG_ADMIN');
      const invitation = await invite(org, by.email);
      await accept(by, invitation.token).expect(409);
      await accept(by, invitation.token).expect(409);
      expect(await db.userRole.count({ where: { userId: by.id } })).toBe(1);
      await db.organizationMembership.update({
        where: { id: existing.id },
        data: { status },
      });
      const res = await accept(by, invitation.token).expect(200);
      expect(res.body).toMatchObject({ membership: { permission: 'MEMBER' } });
      const memberships = await db.organizationMembership.findMany({
        where: scope(org, by),
      });
      expect(memberships).toHaveLength(2);
      expect(memberships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: existing.id,
            status,
            permission: 'ORG_ADMIN',
          }),
          expect.objectContaining({ status: 'ACTIVE', permission: 'MEMBER' }),
        ]),
      );
      const assigned = await db.userRole.findMany({
        where: { userId: by.id, revokedAt: null },
        include: { role: true },
      });
      expect(assigned.map(({ role }) => role.code).sort()).toEqual([
        'CLIENT',
        'COUNSELOR',
      ]);
    },
  );

  it('rolls back failed delivery and preserves the old token after a failed resend', async () => {
    const org = await organization();
    const by = await actor();
    mail.fail = true;
    await create(org, by.email).expect(503);
    expect(
      await db.organizationInvitation.count({ where: { organizationId: org } }),
    ).toBe(0);
    expect(
      await db.auditLog.count({
        where: { organizationId: org, targetType: 'ORGANIZATION_INVITATION' },
      }),
    ).toBe(0);
    mail.fail = false;
    const invitation = await invite(org, by.email);
    mail.fail = true;
    await change(org, invitation.id, 'resend').expect(503);
    await accept(by, invitation.token).expect(200);
    expect(
      await db.auditLog.count({
        where: {
          targetId: invitation.id,
          action: 'ORGANIZATION_INVITATION_RESENT',
        },
      }),
    ).toBe(0);
  });

  it('accepts at most once for concurrent requests', async () => {
    const org = await organization();
    const by = await actor();
    const invitation = await invite(org, by.email);
    const results = await Promise.all([
      accept(by, invitation.token),
      accept(by, invitation.token),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 400]);
    expect(
      await db.organizationMembership.count({ where: scope(org, by) }),
    ).toBe(1);
  });

  async function waitForOrganizationLock() {
    const deadline = performance.now() + 1_500;
    do {
      const [waiter] = await db.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND query ILIKE '%FROM organizations%'
          AND cardinality(pg_blocking_pids(pid)) > 0
      `;
      if (waiter) return;
      await delay(10);
    } while (performance.now() < deadline);
    throw new Error(
      'Expected an invitation operation to wait for the organization lock',
    );
  }

  it.each(['accept', 'revoke'] as const)(
    'serializes a blocked resend against %s and never revives the previous token',
    async (second) => {
      const org = await organization();
      const by = await actor();
      const invitation = await invite(org, by.email);
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mail.gate = () => {
        entered();
        return gate;
      };
      const resend = change(org, invitation.id, 'resend').then(
        (result) => result,
      );
      // Avoid waiting indefinitely if the route fails before reaching delivery.
      await Promise.race([
        waiting,
        resend.then(() => {
          throw new Error('Resend did not reach delivery');
        }),
      ]);
      const other = (
        second === 'accept'
          ? accept(by, invitation.token)
          : change(org, invitation.id, 'revoke')
      ).then((result) => result);
      try {
        await waitForOrganizationLock();
      } finally {
        release();
        await Promise.allSettled([resend, other]);
      }
      const replies = await Promise.all([resend, other]);
      expect(replies.map(({ status }) => status)).toEqual(
        second === 'accept' ? [200, 400] : [200, 200],
      );
      const rotated = mail.take('ORGANIZATION_INVITATION', by.email);
      if (second === 'accept') await accept(by, rotated.token).expect(200);
      else await invalid(by, rotated.token);
      await invalid(by, invitation.token);
    },
  );

  it.each(['audit', 'membership', 'role'] as const)(
    'rolls back role assignment and consumption on %s failure',
    async (failure) => {
      const org = await organization();
      const by = await actor('COUNSELOR');
      const invitation = await invite(org, by.email);
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`CREATE FUNCTION integration_fail_invitation_acceptance() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic acceptance failure'; END; $$`;
        if (failure === 'audit') {
          await tx.$executeRaw`CREATE CONSTRAINT TRIGGER integration_fail_invitation_acceptance
            AFTER INSERT ON audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
            WHEN (NEW.action = 'ORGANIZATION_INVITATION_ACCEPTED')
            EXECUTE FUNCTION integration_fail_invitation_acceptance()`;
        } else if (failure === 'membership') {
          await tx.$executeRaw`CREATE TRIGGER integration_fail_invitation_acceptance
            BEFORE INSERT ON organization_memberships FOR EACH ROW EXECUTE FUNCTION integration_fail_invitation_acceptance()`;
        } else {
          await tx.$executeRaw`CREATE TRIGGER integration_fail_invitation_acceptance
            BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION integration_fail_invitation_acceptance()`;
        }
      });
      try {
        await accept(by, invitation.token).expect(500);
      } finally {
        await db.$executeRaw`DROP FUNCTION integration_fail_invitation_acceptance() CASCADE`;
      }
      expect(await db.userRole.count({ where: { userId: by.id } })).toBe(1);
      expect(
        await db.organizationMembership.count({ where: scope(org, by) }),
      ).toBe(0);
      expect(
        await db.organizationInvitation.findUniqueOrThrow({
          where: { id: invitation.id },
        }),
      ).toMatchObject({ status: 'PENDING', acceptedAt: null });
      await accept(by, invitation.token).expect(200);
    },
  );
});
