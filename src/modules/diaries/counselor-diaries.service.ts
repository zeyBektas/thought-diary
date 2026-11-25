import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JournalEntryType, Prisma } from '@prisma/client';
import { PrismaService } from '@/core/prisma/prisma.service';
import { ListCounselorDiariesDto } from './dto/list-counselor-diaries.dto';

type DiaryRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  entryType: JournalEntryType;
  content: Prisma.JsonValue;
  intensityBefore: number | null;
  intensityAfter: number | null;
  primaryEmotion: { id: string; code: string } | null;
  client: { id: string; firstName: string; lastName: string };
};
type Position = { createdAt: Date; id: string };
type ListRow = { eligible: boolean } & (DiaryRow | { id: null });

@Injectable()
export class CounselorDiariesService {
  constructor(private readonly prisma: PrismaService) {}

  private authorization(userId: string) {
    return Prisma.sql`j."deletedAt" IS NULL AND j.visibility = 'COUNSELOR'
      AND owner."deletedAt" IS NULL AND owner.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM user_roles owner_assignment
        JOIN roles owner_role ON owner_role.id = owner_assignment."roleId"
        WHERE owner_assignment."userId" = owner.id AND owner_assignment."revokedAt" IS NULL
          AND owner_role.code = 'CLIENT' AND owner_role."deletedAt" IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM journal_shares s
        JOIN care_relationships r ON r.id = s."relationshipId"
        JOIN users counselor ON counselor.id = r."counselorId"
        WHERE s."journalId" = j.id AND r."clientId" = j."userId"
          AND r."counselorId" = ${userId} AND r.status = 'ACTIVE' AND r."deletedAt" IS NULL
          AND counselor.status = 'ACTIVE' AND counselor."deletedAt" IS NULL
          AND EXISTS (
            SELECT 1 FROM user_roles counselor_assignment
            JOIN roles counselor_role ON counselor_role.id = counselor_assignment."roleId"
            WHERE counselor_assignment."userId" = counselor.id AND counselor_assignment."revokedAt" IS NULL
              AND counselor_role.code = 'COUNSELOR' AND counselor_role."deletedAt" IS NULL
          )
      )`;
  }

  private query(userId: string, extra: Prisma.Sql) {
    return Prisma.sql`SELECT j.id, j."createdAt", j."updatedAt", j."entryType", j.content,
      j."intensityBefore", j."intensityAfter",
      CASE WHEN emotion.id IS NULL THEN NULL ELSE jsonb_build_object('id', emotion.id, 'code', emotion.code) END AS "primaryEmotion",
      jsonb_build_object('id', owner.id, 'firstName', owner."firstName", 'lastName', owner."lastName") AS client
      FROM journals j JOIN users owner ON owner.id = j."userId"
      LEFT JOIN emotions emotion ON emotion.id = j."primaryEmotionId" AND emotion."deletedAt" IS NULL
      WHERE ${this.authorization(userId)} ${extra}`;
  }

  private decode(cursor: string): Position {
    try {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw new Error();
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) throw new Error();
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        typeof value[0] !== 'string' ||
        typeof value[1] !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value[1],
        )
      )
        throw new Error();
      const createdAt = new Date(value[0]);
      if (
        Number.isNaN(createdAt.valueOf()) ||
        createdAt.toISOString() !== value[0]
      )
        throw new Error();
      return { createdAt, id: value[1] };
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }

  async list(userId: string, query: ListCounselorDiariesDto) {
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (query.limit !== undefined &&
        !/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit))
    )
      throw new BadRequestException('Invalid limit');
    const position =
      query.cursor === undefined ? null : this.decode(query.cursor);
    const paging = position
      ? Prisma.sql`AND (j."createdAt", j.id) < (${position.createdAt}, ${position.id})`
      : Prisma.empty;
    // Eligibility and page contents must be observed in the same statement snapshot.
    const result = await this.prisma.$queryRaw<ListRow[]>(Prisma.sql`
      SELECT caller.eligible, page.*
      FROM (SELECT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = ${userId} AND u.status = 'ACTIVE' AND u."deletedAt" IS NULL
          AND EXISTS (
            SELECT 1 FROM user_roles assignment JOIN roles role ON role.id = assignment."roleId"
            WHERE assignment."userId" = u.id AND assignment."revokedAt" IS NULL
              AND role.code = 'COUNSELOR' AND role."deletedAt" IS NULL
          )
      ) AS eligible) caller
      LEFT JOIN LATERAL (${this.query(
        userId,
        Prisma.sql`${paging} ORDER BY j."createdAt" DESC, j.id DESC LIMIT ${limit + 1}`,
      )}) page ON caller.eligible
      ORDER BY page."createdAt" DESC, page.id DESC
    `);
    if (!result[0]?.eligible)
      throw new ForbiddenException(
        'Only active counselors can access shared diaries',
      );
    const rows: DiaryRow[] = result.flatMap((row) => {
      if (row.id === null) return [];
      return [
        {
          id: row.id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          entryType: row.entryType,
          content: row.content,
          intensityBefore: row.intensityBefore,
          intensityAfter: row.intensityAfter,
          primaryEmotion: row.primaryEmotion,
          client: row.client,
        },
      ];
    });
    const entries = rows.slice(0, limit);
    const last = entries[entries.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify([last.createdAt.toISOString(), last.id]),
          ).toString('base64url')
        : null;
    return { entries, nextCursor };
  }

  async detail(userId: string, id: string) {
    const rows = await this.prisma.$queryRaw<DiaryRow[]>(
      this.query(userId, Prisma.sql`AND j.id = ${id} LIMIT 1`),
    );
    if (!rows[0]) throw new NotFoundException('Diary not found');
    return rows[0];
  }
}
