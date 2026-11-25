import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

function trimText({ value }: { value: unknown }) {
  return typeof value === 'string' ? value.trim() : value;
}

function trimMultilineText({ value }: { value: unknown }) {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').trim()
    : value;
}

export class CounselorProfileDto {
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @Length(1, 120)
  @Matches(/^[^<>\p{Cc}]+$/u, {
    message: 'professionalTitle must be single-line plain text',
  })
  professionalTitle?: string | null;

  @IsOptional()
  @Transform(trimMultilineText)
  @IsString()
  @Length(1, 2000)
  @Matches(/^(?:[\n\t]|[^<>\p{Cc}])+$/u, {
    message: 'biography must be plain text',
  })
  biography?: string | null;
}

export class CounselorDecisionReasonDto {
  @Transform(trimText)
  @IsString()
  @Length(1, 500)
  @Matches(/^[^<>\p{Cc}]+$/u, { message: 'reason must be plain text' })
  reason!: string;
}
