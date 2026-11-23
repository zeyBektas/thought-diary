import { Test, TestingModule } from '@nestjs/testing';
import { DiariesService } from './diaries.service';
import { PrismaService } from '@/core/prisma/prisma.service';

describe('DiariesService', () => {
  let service: DiariesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiariesService, { provide: PrismaService, useValue: {} }],
    }).compile();

    service = module.get<DiariesService>(DiariesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
