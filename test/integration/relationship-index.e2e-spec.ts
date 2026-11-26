import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/prisma/prisma.service';

describe('isolated relationship context indexes after migration replay', () => {
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

  it('enforces the exact partial uniqueness rules for both contexts', async () => {
    const indexes = await db.$queryRaw<
      Array<{
        name: string;
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
      SELECT idx.relname AS name, i.indisunique AS "unique", i.indisvalid AS valid,
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
        AND idx.relname IN (
          'care_relationships_non_revoked_independent_pair_key',
          'care_relationships_non_revoked_organization_pair_key'
        )
      ORDER BY idx.relname
    `;
    const uniqueIndex = {
      unique: true,
      valid: true,
      ready: true,
      immediate: true,
      expressionColumns: false,
    };
    expect(indexes).toMatchObject([
      {
        ...uniqueIndex,
        name: 'care_relationships_non_revoked_independent_pair_key',
        columns: ['counselorId', 'clientId'],
        attributes: 2,
        keyAttributes: 2,
      },
      {
        ...uniqueIndex,
        name: 'care_relationships_non_revoked_organization_pair_key',
        columns: ['counselorId', 'clientId', 'organizationId'],
        attributes: 3,
        keyAttributes: 3,
      },
    ]);
    expect(indexes[0].predicate).toMatch(
      /^\(\("organizationId" IS NULL\) AND \((?:status|"status") <> 'REVOKED'::(?:(?:public|"public")\.)?"CareRelationshipStatus"\)\)$/,
    );
    expect(indexes[1].predicate).toMatch(
      /^\(\("organizationId" IS NOT NULL\) AND \((?:status|"status") <> 'REVOKED'::(?:(?:public|"public")\.)?"CareRelationshipStatus"\)\)$/,
    );
  });

  it('removes both previous global pair indexes', async () => {
    const old = await db.$queryRaw<Array<{ name: string }>>`
      SELECT idx.relname AS name
      FROM pg_class idx JOIN pg_namespace ns ON ns.oid = idx.relnamespace
      WHERE ns.nspname = 'public'
        AND idx.relname IN (
          'care_relationships_counselorId_clientId_key',
          'care_relationships_non_revoked_pair_key'
        )
    `;
    expect(old).toEqual([]);
  });

  it('preserves the validated foreign key and enabled provenance trigger', async () => {
    const foreignKey = await db.$queryRaw<
      Array<{
        definition: string;
        validated: boolean;
      }>
    >`
      SELECT pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
      FROM pg_constraint c
      JOIN pg_class tbl ON tbl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = 'public' AND tbl.relname = 'care_relationships'
        AND c.conname = 'care_relationships_organizationId_fkey' AND c.contype = 'f'
    `;
    expect(foreignKey).toEqual([
      {
        definition:
          'FOREIGN KEY ("organizationId") REFERENCES organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT',
        validated: true,
      },
    ]);
    const trigger = await db.$queryRaw<
      Array<{ enabled: string; definition: string }>
    >`
      SELECT t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_class tbl ON tbl.oid = t.tgrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = 'public' AND tbl.relname = 'care_relationships'
        AND t.tgname = 'care_relationships_organization_immutable' AND NOT t.tgisinternal
    `;
    expect(trigger).toEqual([
      {
        enabled: 'O',
        definition: expect.stringContaining(
          'BEFORE UPDATE OF "organizationId" ON public.care_relationships FOR EACH ROW EXECUTE FUNCTION prevent_relationship_organization_change()',
        ) as string,
      },
    ]);
  });
});
