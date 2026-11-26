import { OrganizationPermission } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

function trim({ value }: { value: unknown }) {
  return typeof value === 'string' ? value.trim() : value;
}

const singleLine = /^[^<>\p{Cc}\u2028\u2029]+$/u;
const webUrlOptions = {
  protocols: ['http', 'https'],
  require_protocol: true,
};

export class CreateOrganizationDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  @Matches(singleLine)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Matches(/^(?:[\n\r\t]|[^<>\p{Cc}])+$/u)
  description?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsUrl(webUrlOptions)
  @MaxLength(2048)
  website?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsUrl(webUrlOptions)
  @MaxLength(2048)
  logoUrl?: string | null;
}

export class OrganizationDecisionDto {
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  @Matches(singleLine, { message: 'reason must be single-line plain text' })
  reason!: string;
}

export class CreateOrganizationMembershipDto {
  @IsUUID()
  userId!: string;
}

export class UpdateOrganizationPermissionDto {
  @IsEnum(OrganizationPermission)
  permission!: OrganizationPermission;
}
