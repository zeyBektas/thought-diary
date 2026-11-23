import { IsOptional, IsString, Matches } from 'class-validator';

export class ListCounselorDiariesDto {
  @IsOptional()
  @IsString()
  @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,256}$/)
  cursor?: string;
}
