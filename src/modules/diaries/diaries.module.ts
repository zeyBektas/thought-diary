import { Module } from '@nestjs/common';
import { DiariesService } from './diaries.service';
import { DiariesController } from './diaries.controller';

@Module({
  controllers: [DiariesController],
  providers: [DiariesService],
})
export class DiariesModule {}
