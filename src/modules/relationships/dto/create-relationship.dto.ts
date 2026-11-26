import { IsOptional, IsUUID } from 'class-validator';

export class CreateRelationshipDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string | null;
}
