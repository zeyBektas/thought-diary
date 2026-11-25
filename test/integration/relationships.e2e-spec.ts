import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RoleCode } from '@prisma/client';
import { Server } from 'node:http';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';
import { UsersService } from '../../src/modules/users/users.service';
import { BCRYPT_HASH_ROUNDS } from '../../src/modules/auth/auth.constants';

describe('isolated relationship lifecycle', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let counselor: { id: string; token: string };
  let client: { id: string; token: string };
  let other: { id: string; token: string };
  const password = 'fixture-password';
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
    prisma = app.get(PrismaService);
    for (const code of [RoleCode.CLIENT, RoleCode.COUNSELOR])
      await prisma.role.upsert({
        where: { code },
        update: {},
        create: { code },
      });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: RoleCode.COUNSELOR },
    });
    const user = await app.get(UsersService).create({
      email: 'counselor@example.test',
      firstName: 'Test',
      lastName: 'Counselor',
      roleId: role.id,
      passwordHash: await bcrypt.hash(password, BCRYPT_HASH_ROUNDS),
    });
    await prisma.counselorProfile.create({
      data: { userId: user.id, approvalStatus: 'APPROVED' },
    });
    const login = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ email: user.email, password });
    expect(login.status).toBe(200);
    counselor = {
      id: user.id,
      token: (login.body as { accessToken: string }).accessToken,
    };
    async function createClient(email: string) {
      const result = await request(app.getHttpServer() as Server)
        .post('/auth/register')
        .send({ email, password, firstName: 'Test', lastName: 'Client' });
      expect(result.status).toBe(201);
      const body = result.body as { user: { id: string }; accessToken: string };
      return {
        id: body.user.id,
        token: body.accessToken,
      };
    }
    client = await createClient('client@example.test');
    other = await createClient('other@example.test');
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('requests, lists, accepts, and revokes with ownership and transition enforcement', async () => {
    expect(
      (await request(app.getHttpServer() as Server).get('/relationships'))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/relationships')
          .set('Authorization', bearer(client.token))
          .send({ clientId: other.id })
      ).status,
    ).toBe(403);
    const created = await request(app.getHttpServer() as Server)
      .post('/relationships')
      .set('Authorization', bearer(counselor.token))
      .send({ clientId: client.id });
    expect(created.status).toBe(201);
    const body = created.body as {
      id: string;
      status: string;
      client: { passwordHash?: string };
    };
    const id = body.id;
    expect(body.status).toBe('PENDING');
    expect(body.client.passwordHash).toBeUndefined();
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/relationships')
          .set('Authorization', bearer(counselor.token))
          .send({ clientId: client.id })
      ).status,
    ).toBe(409);
    const list = await request(app.getHttpServer() as Server)
      .get('/relationships')
      .set('Authorization', bearer(client.token));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .get('/relationships')
          .set('Authorization', bearer(other.token))
      ).body,
    ).toHaveLength(0);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}`)
          .set('Authorization', bearer(other.token))
          .send({ status: 'ACTIVE' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}`)
          .set('Authorization', bearer(client.token))
          .send({ status: 'REVOKED' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}`)
          .set('Authorization', bearer(client.token))
          .send({ status: 'ACTIVE' })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}`)
          .set('Authorization', bearer(client.token))
          .send({ status: 'REJECTED' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}/revoke`)
          .set('Authorization', bearer(other.token))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}/revoke`)
          .set('Authorization', bearer(counselor.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}/revoke`)
          .set('Authorization', bearer(client.token))
      ).status,
    ).toBe(400);
  });

  it('rejects a separate pending request and excludes soft-deleted records', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/relationships')
      .set('Authorization', bearer(counselor.token))
      .send({ clientId: other.id });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}`)
          .set('Authorization', bearer(other.token))
          .send({ status: 'REJECTED' })
      ).status,
    ).toBe(200);
    await prisma.careRelationship.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    expect(
      (
        await request(app.getHttpServer() as Server)
          .get('/relationships')
          .set('Authorization', bearer(other.token))
      ).body,
    ).toHaveLength(0);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .patch(`/relationships/${id}`)
          .set('Authorization', bearer(other.token))
          .send({ status: 'ACTIVE' })
      ).status,
    ).toBe(404);
  });
});
