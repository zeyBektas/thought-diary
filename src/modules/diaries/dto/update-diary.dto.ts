import { PartialType } from '@nestjs/mapped-types';
import { CreateDiaryDto } from './create-diary.dto';
import { Matches, ValidateIf } from 'class-validator';

export class UpdateDiaryDto extends PartialType(CreateDiaryDto) {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Matches(/^[a-f0-9]{64}$/)
  shareVersion?: string;
}
