import { Module } from '@nestjs/common';
import { DiariesService } from './diaries.service';
import { DiariesController } from './diaries.controller';
import { EmotionsController } from './emotions.controller';

@Module({
  controllers: [DiariesController, EmotionsController],
  providers: [DiariesService],
})
export class DiariesModule {}
