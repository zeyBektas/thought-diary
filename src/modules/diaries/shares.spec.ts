import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JournalVisibility } from '@prisma/client';
import { validate } from 'class-validator';
import { createHash } from 'node:crypto';
import { PrismaService } from '@/core/prisma/prisma.service';
import { DiariesService } from './diaries.service';
import { ReplaceSharesDto } from './dto/replace-shares.dto';

describe('diary sharing', () => {
  const version = createHash('sha256')
    .update(JSON.stringify(['entry', 0, []]))
    .digest('hex');
  const tx = {
    $queryRaw: jest.fn(),
    user: { findFirst: jest.fn() },
    journal: { findFirst: jest.fn(), update: jest.fn() },
    careRelationship: { count: jest.fn() },
    journalShare: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (value: typeof tx) => unknown) => fn(tx),
  };
  const service = new DiariesService(prisma as unknown as PrismaService);
  beforeEach(() => {
    jest.resetAllMocks();
    tx.user.findFirst.mockResolvedValue({ id: 'owner' });
    tx.journal.findFirst.mockResolvedValue({
      id: 'entry',
      userId: 'owner',
      visibility: JournalVisibility.COUNSELOR,
      shareRevision: 0,
    });
    tx.journal.update.mockResolvedValue({ id: 'entry' });
    tx.careRelationship.count.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.length),
    );
    tx.journalShare.findMany.mockResolvedValue([]);
  });
  it('rejects malformed and duplicate UUIDs', async () => {
    const dto = new ReplaceSharesDto();
    dto.recipientRelationshipIds = ['bad', 'bad'];
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
  it('rejects users without an active client role and missing or other owners', async () => {
    tx.user.findFirst.mockResolvedValueOnce(null);
    await expect(service.getShares('other', 'entry')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    tx.journal.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.replaceShares('other', 'entry', [], version),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('replaces and removes recipients, returning effective recipients', async () => {
    await expect(
      service.replaceShares('owner', 'entry', ['rel'], version),
    ).resolves.toEqual({
      recipients: [],
      shareVersion: expect.any(String) as string,
    });
    expect(tx.journalShare.deleteMany).toHaveBeenCalledWith({
      where: { journalId: 'entry' },
    });
    expect(tx.journalShare.createMany).toHaveBeenCalledWith({
      data: [{ journalId: 'entry', relationshipId: 'rel' }],
    });
    await service.replaceShares('owner', 'entry', [], version);
    expect(tx.journalShare.createMany).toHaveBeenCalledTimes(1);
  });
  it('filters effective recipients by the actual journal owner', async () => {
    const counselor = {
      id: 'counselor',
      firstName: 'Valid',
      lastName: 'Counselor',
      username: null,
    };
    tx.journalShare.findMany
      .mockResolvedValueOnce([{ id: 'grant' }])
      .mockResolvedValueOnce([
        { relationshipId: 'valid', relationship: { counselor } },
      ]);
    await expect(service.getShares('owner', 'entry')).resolves.toEqual({
      shareVersion: expect.any(String) as string,
      recipients: [{ relationshipId: 'valid', counselor }],
    });
    expect(tx.journalShare.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          journalId: 'entry',
          journal: { visibility: JournalVisibility.COUNSELOR, deletedAt: null },
          relationship: {
            clientId: 'owner',
            status: 'ACTIVE',
            deletedAt: null,
            counselor: {
              status: 'ACTIVE',
              deletedAt: null,
              role: { code: 'COUNSELOR', deletedAt: null },
            },
          },
        },
      }),
    );
  });
  it('rejects ineligible cross-client recipients before deleting grants', async () => {
    tx.careRelationship.count.mockResolvedValue(0);
    await expect(
      service.replaceShares('owner', 'entry', ['other'], version),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.journalShare.deleteMany).not.toHaveBeenCalled();
  });
  it('rejects private entries and duplicate recipients', async () => {
    tx.journal.findFirst.mockResolvedValueOnce({
      id: 'entry',
      visibility: JournalVisibility.PRIVATE,
      shareRevision: 0,
    });
    await expect(
      service.replaceShares('owner', 'entry', [], version),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.replaceShares('owner', 'entry', ['rel', 'rel'], version),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('preserves omitted recipients and clears them on visibility change', async () => {
    await service.update('owner', 'entry', { content: {} });
    expect(tx.journalShare.deleteMany).not.toHaveBeenCalled();
    await service.update('owner', 'entry', {
      visibility: JournalVisibility.PRIVATE,
    });
    expect(tx.journalShare.deleteMany).toHaveBeenCalledWith({
      where: { journalId: 'entry' },
    });
  });
  it('replaces recipients when an update supplies them and strips the field from diary data', async () => {
    await service.update('owner', 'entry', {
      recipientRelationshipIds: ['rel'],
      shareVersion: version,
    });
    expect(tx.journal.update).toHaveBeenCalledWith({
      where: { id: 'entry' },
      data: { shareRevision: { increment: 1 } },
      omit: { shareRevision: true },
    });
    expect(tx.journalShare.deleteMany).toHaveBeenCalled();
    expect(tx.journalShare.createMany).toHaveBeenCalled();
  });

  it('uses stable relationship lock ordering before validation', async () => {
    await service.replaceShares('owner', 'entry', ['z', 'a'], version);
    const calls = tx.$queryRaw.mock.calls as unknown[][];
    expect(calls[1][1]).toBe('a');
    expect(calls[2][1]).toBe('z');
  });
  it('locks existing omitted relationships before comparing the token', async () => {
    tx.journalShare.findMany
      .mockResolvedValueOnce([{ relationshipId: 'a' }])
      .mockResolvedValueOnce([{ id: 'changed' }]);
    await expect(
      service.replaceShares('owner', 'entry', ['z'], version),
    ).rejects.toBeInstanceOf(ConflictException);
    const calls = tx.$queryRaw.mock.calls as unknown[][];
    expect(calls[1][1]).toBe('a');
    expect(calls[2][1]).toBe('z');
    expect(tx.journalShare.deleteMany).not.toHaveBeenCalled();
  });
  it('rejects recipients when resulting visibility is private', async () => {
    await expect(
      service.update('owner', 'entry', {
        visibility: JournalVisibility.PRIVATE,
        recipientRelationshipIds: ['rel'],
        shareVersion: version,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.journal.update).not.toHaveBeenCalled();
  });
});
