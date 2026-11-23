import { Module } from '@nestjs/common';
import { DiariesService } from './diaries.service';
import { DiariesController } from './diaries.controller';
import { EmotionsController } from './emotions.controller';
import { CounselorDiariesController } from './counselor-diaries.controller';
import { CounselorDiariesService } from './counselor-diaries.service';

@Module({
  controllers: [
    DiariesController,
    EmotionsController,
    CounselorDiariesController,
  ],
  providers: [DiariesService, CounselorDiariesService],
})
export class DiariesModule {}
