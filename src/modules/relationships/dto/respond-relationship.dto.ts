import { CareRelationshipStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

export class RespondRelationshipDto {
  @IsIn([CareRelationshipStatus.ACTIVE, CareRelationshipStatus.REJECTED])
  status!: Extract<CareRelationshipStatus, 'ACTIVE' | 'REJECTED'>;
}
