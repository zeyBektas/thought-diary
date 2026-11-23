import { Test, TestingModule } from '@nestjs/testing';
import { DiariesController } from './diaries.controller';
import { DiariesService } from './diaries.service';
import { PrismaService } from '@/core/prisma/prisma.service';

describe('DiariesController', () => {
  let controller: DiariesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiariesController],
      providers: [DiariesService, { provide: PrismaService, useValue: {} }],
    }).compile();

    controller = module.get<DiariesController>(DiariesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
