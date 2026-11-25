import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/core/prisma/prisma.service';
import { CounselorDiariesService } from './counselor-diaries.service';

describe('CounselorDiariesService', () => {
  const db = { $queryRaw: jest.fn() };
  const service = new CounselorDiariesService(db as unknown as PrismaService);
  beforeEach(() => {
    jest.resetAllMocks();
    db.$queryRaw.mockResolvedValue([{ eligible: true, id: null }]);
  });
  it('rejects invalid limits and cursors', async () => {
    await expect(service.list('c', { limit: '0' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.list('c', { cursor: 'invalid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects ineligible list callers and returns uniform missing detail', async () => {
    db.$queryRaw.mockResolvedValueOnce([{ eligible: false, id: null }]);
    await expect(service.list('c', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    db.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.detail('c', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('returns an empty page for an eligible counselor in one statement', async () => {
    await expect(service.list('c', {})).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const calls = db.$queryRaw.mock.calls as Array<
      [
        {
          sql: string;
          values: unknown[];
        },
      ]
    >;
    const statement = calls[0][0];
    expect(statement.sql).toContain('LEFT JOIN LATERAL');
    expect(statement.sql).toContain('ON caller.eligible');
    expect(statement.sql).toContain('counselor_role."deletedAt" IS NULL');
    expect(statement.sql).toContain('counselor_assignment."revokedAt" IS NULL');
    expect(statement.sql).toContain(
      'counselor_assignment."userId" = counselor.id',
    );
    expect(statement.sql).toContain('profile."approvalStatus" = \'APPROVED\'');
    expect(statement.values).toContain('c');
  });
  it('does not return rows when the statement reports an ineligible caller', async () => {
    db.$queryRaw.mockResolvedValueOnce([{ eligible: false, id: null }]);
    await expect(service.list('c', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('removes the eligibility marker and preserves pagination', async () => {
    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    const diary = {
      id: '00000000-0000-0000-0000-000000000002',
      createdAt,
      updatedAt: createdAt,
      entryType: 'FREE_JOURNAL',
      content: { text: 'entry' },
      intensityBefore: null,
      intensityAfter: null,
      primaryEmotion: null,
      client: { id: 'client', firstName: 'A', lastName: 'B' },
    };
    db.$queryRaw.mockResolvedValueOnce([
      { eligible: true, ...diary },
      { eligible: true, ...diary, id: '00000000-0000-0000-0000-000000000001' },
    ]);
    await expect(service.list('c', { limit: '1' })).resolves.toEqual({
      entries: [diary],
      nextCursor: Buffer.from(
        JSON.stringify([createdAt.toISOString(), diary.id]),
      ).toString('base64url'),
    });
  });
  it('uses the same owner and grant authorization for list and detail', async () => {
    await service.list('c', {});
    db.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.detail('c', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    for (const call of db.$queryRaw.mock.calls as Array<[{ sql: string }]>) {
      expect(call[0].sql).toContain('r."clientId" = j."userId"');
      expect(call[0].sql).toContain('s."journalId" = j.id');
      expect(call[0].sql).toContain('counselor_role."deletedAt" IS NULL');
      expect(call[0].sql).toContain('owner_assignment."revokedAt" IS NULL');
      expect(call[0].sql).toContain('owner_assignment."userId" = owner.id');
      expect(call[0].sql).toContain('counselor_assignment."revokedAt" IS NULL');
      expect(call[0].sql).toContain(
        'counselor_assignment."userId" = counselor.id',
      );
      expect(call[0].sql).toContain(
        'JOIN counselor_profiles profile ON profile."userId" = counselor.id',
      );
      expect(call[0].sql).toContain('profile."approvalStatus" = \'APPROVED\'');
    }
  });
});
