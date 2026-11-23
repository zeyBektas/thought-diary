import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

describe('isolated relationship index after migration replay', () => {
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

  it('retains the exact unique partial index and removes the old index', async () => {
    const indexes = await db.$queryRaw<
      Array<{
        unique: boolean;
        valid: boolean;
        ready: boolean;
        immediate: boolean;
        columns: string[];
        attributes: number;
        keyAttributes: number;
        expressionColumns: boolean;
        predicate: string | null;
      }>
    >`
      SELECT i.indisunique AS "unique", i.indisvalid AS valid,
        i.indisready AS ready, i.indimmediate AS immediate,
        i.indnatts::int AS attributes, i.indnkeyatts::int AS "keyAttributes",
        i.indexprs IS NOT NULL AS "expressionColumns",
        pg_get_expr(i.indpred, i.indrelid) AS predicate,
        ARRAY(SELECT a.attname::text
          FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          ORDER BY k.ord) AS columns
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = 'public' AND tbl.relname = 'care_relationships'
        AND idx.relname = 'care_relationships_non_revoked_pair_key'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toMatchObject({
      unique: true,
      valid: true,
      ready: true,
      immediate: true,
      columns: ['counselorId', 'clientId'],
      attributes: 2,
      keyAttributes: 2,
      expressionColumns: false,
    });
    expect(indexes[0].predicate).toMatch(
      /^\((?:status|"status") <> 'REVOKED'::(?:(?:public|"public")\.)?"CareRelationshipStatus"\)$/,
    );
    const old = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_class idx JOIN pg_namespace ns ON ns.oid = idx.relnamespace
        WHERE ns.nspname = 'public'
          AND idx.relname = 'care_relationships_counselorId_clientId_key'
      ) AS "exists"
    `;
    expect(old).toEqual([{ exists: false }]);
  });
});
