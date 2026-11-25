import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '../../users/users.service';

describe('JwtStrategy', () => {
  it('resolves identity from the database and ignores old token role claims', async () => {
    const secret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'test-only-secret';
    try {
      const resolveCurrentUser = jest
        .fn()
        .mockResolvedValue({ userId: 'user', roles: ['CLIENT'] });
      const strategy = new JwtStrategy({
        resolveCurrentUser,
      } as unknown as UsersService);
      const payload = {
        sub: 'user',
        role: 'PLATFORM_ADMIN',
        email: 'stale@example.test',
      };
      await expect(strategy.validate(payload)).resolves.toEqual({
        userId: 'user',
        roles: ['CLIENT'],
      });
      expect(resolveCurrentUser).toHaveBeenCalledWith('user');
    } finally {
      if (secret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = secret;
    }
  });
});
