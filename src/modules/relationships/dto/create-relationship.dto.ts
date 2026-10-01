import { IsUUID } from 'class-validator';

export class CreateRelationshipDto {
  @IsUUID()
  clientId!: string;
}
