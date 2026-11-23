import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly pool: Pool;

  constructor(private readonly configService: ConfigService) {
    const connectionString = configService.getOrThrow<string>('DATABASE_URL');

    const pool = new Pool({
      connectionString,
    });

    const adapter = new PrismaPg(pool);

    super({
      adapter,
    });

    this.pool = pool;
  }

  async onModuleInit() {
    try {
      await this.$connect();
    } catch (error) {
      try {
        await this.closeConnections();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Prisma initialization and cleanup failed.',
        );
      }

      throw error;
    }
  }

  async onModuleDestroy() {
    await this.closeConnections();
  }

  private async closeConnections() {
    let disconnectError: unknown;

    try {
      await this.$disconnect();
    } catch (error) {
      disconnectError = error;
    }

    try {
      await this.pool.end();
    } catch (poolError) {
      if (disconnectError) {
        throw new AggregateError(
          [disconnectError, poolError],
          'Failed to close Prisma connections.',
        );
      }
      throw poolError;
    }

    if (disconnectError) {
      throw new AggregateError(
        [disconnectError],
        'Failed to disconnect Prisma client.',
      );
    }
  }
}
