import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

describe('isolated legacy role backfill', () => {
  let app: INestApplication;
  let db: PrismaService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    db = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('backfills only historical legacy roles without inventing actors or timestamps, and never regrants on rerun', async () => {
    const migration = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20261125000000_user_role_backfill/migration.sql',
      ),
      'utf8',
    );
    const begin = '-- BEGIN ROLE BACKFILL';
    const end = '-- END ROLE BACKFILL';
    expect(migration.split(begin)).toHaveLength(2);
    expect(migration.split(end)).toHaveLength(2);
    const statement = migration.split(begin)[1].split(end)[0].trim();
    expect(statement).toContain('INSERT INTO "user_roles"');

    // Only temporary tables are shadowed on this one connection. The exact
    // migration statement cannot read or modify real test-suite fixtures.
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "roles" (id TEXT PRIMARY KEY, code TEXT NOT NULL) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "users" (id TEXT PRIMARY KEY, "roleId" TEXT NOT NULL) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "user_roles" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "roleId" TEXT NOT NULL, "assignedById" TEXT, "assignedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3)) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(
          'CREATE UNIQUE INDEX ON "user_roles" ("userId", "roleId") WHERE "revokedAt" IS NULL',
        );
        await tx.$executeRaw`INSERT INTO "roles" (id, code) VALUES ('client-role', 'CLIENT'), ('counselor-role', 'COUNSELOR'), ('admin-role', 'ADMIN'), ('platform-role', 'PLATFORM_ADMIN')`;
        await tx.$executeRaw`INSERT INTO "users" (id, "roleId") VALUES ('client', 'client-role'), ('counselor', 'counselor-role'), ('admin', 'admin-role'), ('platform', 'platform-role'), ('revoked', 'client-role')`;
        await tx.$executeRaw`INSERT INTO "user_roles" (id, "userId", "roleId", "revokedAt") VALUES ('historical', 'revoked', 'client-role', '2020-01-01')`;
        await tx.$executeRawUnsafe(statement);
        const assignments = await tx.$queryRaw<
          Array<{
            userId: string;
            roleId: string;
            assignedById: string | null;
            assignedAt: Date | null;
            revokedAt: Date | null;
          }>
        >`
        SELECT "userId", "roleId", "assignedById", "assignedAt", "revokedAt" FROM "user_roles" ORDER BY "userId"`;
        expect(assignments).toEqual([
          {
            userId: 'admin',
            roleId: 'admin-role',
            assignedById: null,
            assignedAt: null,
            revokedAt: null,
          },
          {
            userId: 'client',
            roleId: 'client-role',
            assignedById: null,
            assignedAt: null,
            revokedAt: null,
          },
          {
            userId: 'counselor',
            roleId: 'counselor-role',
            assignedById: null,
            assignedAt: null,
            revokedAt: null,
          },
          {
            userId: 'revoked',
            roleId: 'client-role',
            assignedById: null,
            assignedAt: null,
            revokedAt: new Date('2020-01-01T00:00:00.000Z'),
          },
        ]);
        await tx.$executeRaw`UPDATE "user_roles" SET "revokedAt" = '2021-01-01' WHERE "userId" = 'client'`;
        await tx.$executeRawUnsafe(statement);
        const after = await tx.$queryRaw<
          Array<{ userId: string; count: bigint; active: bigint }>
        >`
        SELECT "userId", count(*) AS count, count(*) FILTER (WHERE "revokedAt" IS NULL) AS active FROM "user_roles" GROUP BY "userId" ORDER BY "userId"`;
        expect(after).toEqual([
          { userId: 'admin', count: 1n, active: 1n },
          { userId: 'client', count: 1n, active: 0n },
          { userId: 'counselor', count: 1n, active: 1n },
          { userId: 'revoked', count: 1n, active: 0n },
        ]);
      },
      { timeout: 15000 },
    );
  });
});
