import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { RespondRelationshipDto } from './dto/respond-relationship.dto';
import { RelationshipsController } from './relationships.controller';

describe('RelationshipsController security and DTOs', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (
    value: object,
    metatype: typeof CreateRelationshipDto | typeof RespondRelationshipDto,
  ) => pipe.transform(value, { type: 'body', metatype });

  it('protects all controller routes with JwtAuthGuard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, RelationshipsController),
    ).toContain(JwtAuthGuard);
  });

  it('accepts the clientId UUID contract and rejects invalid or extra fields', async () => {
    const clientId = 'a39d0588-aca4-443e-b261-3829ae6958ae';
    await expect(
      validate({ clientId }, CreateRelationshipDto),
    ).resolves.toMatchObject({ clientId });
    await expect(
      validate({ clientId: 'invalid' }, CreateRelationshipDto),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      validate({ clientId, counselorId: clientId }, CreateRelationshipDto),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each(['ACTIVE', 'REJECTED'])(
    'accepts response status %s',
    async (status) => {
      await expect(
        validate({ status }, RespondRelationshipDto),
      ).resolves.toMatchObject({ status });
    },
  );

  it.each(['PENDING', 'REVOKED', 'OTHER'])(
    'rejects response status %s',
    async (status) => {
      await expect(
        validate({ status }, RespondRelationshipDto),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  it('rejects missing or extra response fields', async () => {
    await expect(validate({}, RespondRelationshipDto)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      validate({ status: 'ACTIVE', clientId: 'other' }, RespondRelationshipDto),
    ).rejects.toMatchObject({ status: 400 });
  });
});
