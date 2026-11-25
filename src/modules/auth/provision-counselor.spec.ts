import { RoleCode } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import type { UsersService } from '@/modules/users/users.service';
import { BCRYPT_HASH_ROUNDS } from './auth.constants';

import {
  provisionCounselor,
  readProvisioningInput,
  type ProvisioningDependencies,
} from '../../../prisma/provision-counselor';

function createDependencies(): ProvisioningDependencies & {
  roleFindFirst: jest.Mock;
  findByEmail: jest.Mock;
  create: jest.MockedFunction<UsersService['create']>;
} {
  const roleFindFirst = jest.fn();
  const findByEmail = jest.fn();
  const create = jest.fn<
    ReturnType<UsersService['create']>,
    Parameters<UsersService['create']>
  >();

  return {
    prisma: {
      role: { findFirst: roleFindFirst },
    } as unknown as ProvisioningDependencies['prisma'],
    usersService: { findByEmail, create },
    roleFindFirst,
    findByEmail,
    create,
  };
}

const input = {
  email: 'counselor@example.com',
  password: 'secure-password',
  firstName: 'Casey',
  lastName: 'Counselor',
};

describe('counselor provisioning', () => {
  it('initializes the Nest context with the command TypeScript runtime', () => {
    const script = `
      require('reflect-metadata');
      const { PrismaService } = require('./src/core/prisma/prisma.service');
      PrismaService.prototype.$connect = async function () {};
      PrismaService.prototype.$disconnect = async function () {};
      const { NestFactory } = require('@nestjs/core');
      const { AppModule } = require('./src/app.module');
      NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false })
        .then(async app => { await app.close(); })
        .catch(() => { process.exitCode = 1; });
    `;
    expect(() =>
      execFileSync(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          '-r',
          'tsconfig-paths/register',
          '-e',
          script,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DATABASE_URL: 'postgresql://localhost:1/unused',
            JWT_ACCESS_SECRET: 'test-only-access-secret',
            JWT_REFRESH_SECRET: 'test-only-refresh-secret',
          },
          stdio: 'pipe',
        },
      ),
    ).not.toThrow();
  }, 30000);

  it('validates runtime values with the registration rules without echoing secrets', () => {
    expect(
      readProvisioningInput({
        COUNSELOR_EMAIL: input.email,
        COUNSELOR_PASSWORD: input.password,
        COUNSELOR_FIRST_NAME: input.firstName,
        COUNSELOR_LAST_NAME: input.lastName,
      }),
    ).toEqual(input);

    expect(() =>
      readProvisioningInput({ COUNSELOR_EMAIL: input.email }),
    ).toThrow('Invalid counselor provisioning configuration:');

    try {
      readProvisioningInput({
        COUNSELOR_EMAIL: 'not-an-email',
        COUNSELOR_PASSWORD: 'short',
        COUNSELOR_FIRST_NAME: input.firstName,
        COUNSELOR_LAST_NAME: input.lastName,
      });
      throw new Error('Expected invalid input to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'Invalid counselor provisioning configuration:',
      );
      expect((error as Error).message).not.toContain('short');
    }
  });

  it('provisions a new counselor through the existing user service', async () => {
    const dependencies = createDependencies();
    dependencies.roleFindFirst.mockResolvedValue({ id: 'counselor-role' });
    dependencies.findByEmail.mockResolvedValue(null);
    dependencies.create.mockImplementation((data) =>
      Promise.resolve({ email: data.email } as Awaited<
        ReturnType<UsersService['create']>
      >),
    );

    const result = await provisionCounselor(input, dependencies);

    expect(result).toEqual({ status: 'created', email: input.email });
    expect(dependencies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        roleId: 'counselor-role',
      }),
    );
    const [createInput] = dependencies.create.mock.calls[0];
    expect(createInput.passwordHash).not.toBe(input.password);
    expect(createInput.passwordHash).toMatch(
      new RegExp(`^\\$2[aby]\\$${BCRYPT_HASH_ROUNDS}\\$`),
    );
  });

  it('treats an existing counselor as a no-op', async () => {
    const dependencies = createDependencies();
    dependencies.roleFindFirst.mockResolvedValue({ id: 'counselor-role' });
    dependencies.findByEmail.mockResolvedValue({
      email: input.email,
      roleAssignments: [{ role: { code: RoleCode.COUNSELOR } }],
    });

    await expect(provisionCounselor(input, dependencies)).resolves.toEqual({
      status: 'already-provisioned',
      email: input.email,
    });
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('rejects an existing non-counselor without modifying it', async () => {
    const dependencies = createDependencies();
    dependencies.roleFindFirst.mockResolvedValue({ id: 'counselor-role' });
    dependencies.findByEmail.mockResolvedValue({
      email: input.email,
      roleAssignments: [{ role: { code: RoleCode.CLIENT } }],
    });

    await expect(provisionCounselor(input, dependencies)).rejects.toThrow(
      'Email is already registered to a non-counselor account.',
    );
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('fails safely when the counselor role is missing', async () => {
    const dependencies = createDependencies();
    dependencies.roleFindFirst.mockResolvedValue(null);

    await expect(provisionCounselor(input, dependencies)).rejects.toThrow(
      'COUNSELOR role is missing. Run the standard role seed first.',
    );
    expect(dependencies.findByEmail).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('fails safely when the COUNSELOR role is soft deleted', async () => {
    const dependencies = createDependencies();
    dependencies.roleFindFirst.mockResolvedValue(null);

    await expect(provisionCounselor(input, dependencies)).rejects.toThrow(
      'COUNSELOR role is missing. Run the standard role seed first.',
    );
    expect(dependencies.roleFindFirst).toHaveBeenCalledWith({
      where: { code: RoleCode.COUNSELOR, deletedAt: null },
    });
    expect(dependencies.findByEmail).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });
});
