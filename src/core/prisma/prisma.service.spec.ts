import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { PrismaService } from './prisma.service';

describe('PrismaService initialization cleanup', () => {
  it('disconnects Prisma and closes the pool if connection initialization fails', async () => {
    const service = new PrismaService({
      getOrThrow: () => 'postgresql://localhost/test',
    } as unknown as ConfigService);
    const connectError = new Error('connection failed');
    const disconnect = jest
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined);
    const pool = (service as unknown as { pool: Pool }).pool;
    const end = jest.spyOn(pool, 'end');
    jest.spyOn(service, '$connect').mockRejectedValue(connectError);

    await expect(service.onModuleInit()).rejects.toBe(connectError);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
