import { ArrayUnique, IsArray, IsUUID, Matches } from 'class-validator';

export class ReplaceSharesDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  recipientRelationshipIds!: string[];

  @Matches(/^[a-f0-9]{64}$/)
  shareVersion!: string;
}
