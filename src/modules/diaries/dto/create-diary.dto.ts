import { Prisma, JournalEntryType, JournalVisibility } from '@prisma/client';
import {
  IsDefined,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  IsArray,
  ArrayUnique,
  ValidateIf,
} from 'class-validator';

export class CreateDiaryDto {
  @IsEnum(JournalEntryType)
  entryType!: JournalEntryType;

  @IsDefined()
  @IsObject()
  content!: Prisma.InputJsonValue;

  @IsOptional()
  @IsUUID()
  primaryEmotionId?: string;

  @IsOptional()
  @IsInt()
  intensityBefore?: number;

  @IsOptional()
  @IsInt()
  intensityAfter?: number;

  @IsOptional()
  @IsEnum(JournalVisibility)
  visibility?: JournalVisibility;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  recipientRelationshipIds?: string[];
}
