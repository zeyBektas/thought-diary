import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RoleCode } from '@prisma/client';
import { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';
import { AuthService } from '../../src/modules/auth/auth.service';

describe('isolated authentication', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
    prisma = app.get(PrismaService);
    await prisma.role.upsert({
      where: { code: RoleCode.CLIENT },
      update: {},
      create: { code: RoleCode.CLIENT },
    });
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  async function register(email: string) {
    const response = await request(app.getHttpServer() as Server)
      .post('/auth/register')
      .send({ email, password, firstName: 'Test', lastName: 'Client' });
    expect(response.status).toBe(201);
    return response.body as {
      user: { role: { code: string } };
      accessToken: string;
      refreshToken: string;
    };
  }
  it('registers only CLIENT, rejects role input, logs in, and authenticates /me', async () => {
    const result = await register('auth@example.test');
    expect(result.user.role.code).toBe('CLIENT');
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/register')
          .send({
            email: 'privileged@example.test',
            password,
            firstName: 'Test',
            lastName: 'Client',
            role: 'COUNSELOR',
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/login')
          .send({ email: 'auth@example.test', password: 'wrong' })
      ).status,
    ).toBe(401);
    const login = await request(app.getHttpServer() as Server)
      .post('/auth/login')
      .send({ email: 'auth@example.test', password });
    expect(login.status).toBe(200);
    const loginBody = login.body as { accessToken: string };
    expect(
      (
        await request(app.getHttpServer() as Server)
          .get('/auth/me')
          .set('Authorization', `Bearer ${loginBody.accessToken}`)
      ).status,
    ).toBe(200);
    expect(
      (await request(app.getHttpServer() as Server).get('/auth/me')).status,
    ).toBe(401);
  });
  it('rotates refresh tokens, rejects replay and invalid tokens, and logs out', async () => {
    const registered = await register('refresh@example.test');
    const rotated = await request(app.getHttpServer() as Server)
      .post('/auth/refresh')
      .send({ refreshToken: registered.refreshToken });
    expect(rotated.status).toBe(200);
    const rotatedBody = rotated.body as {
      accessToken: string;
      refreshToken: string;
    };
    expect(
      (
        await request(app.getHttpServer() as Server)
          .get('/auth/me')
          .set('Authorization', `Bearer ${rotatedBody.accessToken}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken: registered.refreshToken })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken: 'invalid' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/logout')
          .send({ refreshToken: rotatedBody.refreshToken })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken: rotatedBody.refreshToken })
      ).status,
    ).toBe(401);
  });
  it('permits at most one concurrent refresh of the same token', async () => {
    const registered = await register('concurrent@example.test');
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken: registered.refreshToken }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    const winner = results.find((result) => result.status === 200)!;
    const { refreshToken } = winner.body as { refreshToken: string };
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken: registered.refreshToken })
      ).status,
    ).toBe(401);
  });

  it('rolls back consumption if replacement persistence fails', async () => {
    const registered = await register('rollback@example.test');
    const original = await prisma.refreshToken.findFirstOrThrow({
      where: { user: { email: 'rollback@example.test' } },
    });
    const auth = app.get(AuthService);
    const internal = auth as unknown as {
      prepareTokens: () => Promise<{
        tokens: { accessToken: string; refreshToken: string };
        data: {
          id: string;
          userId: string;
          tokenHash: string;
          expiresAt: Date;
        };
      }>;
    };
    const spy = jest.spyOn(internal, 'prepareTokens').mockResolvedValue({
      tokens: { accessToken: 'fixture', refreshToken: 'fixture' },
      data: {
        id: original.id,
        userId: original.userId,
        tokenHash: 'unique-fixture-hash',
        expiresAt: new Date('2100-01-01'),
      },
    });
    try {
      await expect(auth.refresh(registered.refreshToken)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    const after = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(after.revokedAt).toBeNull();
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken: registered.refreshToken })
      ).status,
    ).toBe(200);
  });

  it('consumes the original token when refresh races with logout', async () => {
    const registered = await register('logout-race@example.test');
    const results = await Promise.all([
      request(app.getHttpServer() as Server)
        .post('/auth/refresh')
        .send({ refreshToken: registered.refreshToken }),
      request(app.getHttpServer() as Server)
        .post('/auth/logout')
        .send({ refreshToken: registered.refreshToken }),
    ]);
    expect(results[1].status).toBe(200);
    expect([200, 401]).toContain(results[0].status);
    expect(
      (
        await request(app.getHttpServer() as Server)
          .post('/auth/refresh')
          .send({ refreshToken: registered.refreshToken })
      ).status,
    ).toBe(401);
  });
});
