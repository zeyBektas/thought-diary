import 'dotenv/config';

import * as bcrypt from 'bcrypt';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { INestApplicationContext } from '@nestjs/common';
import { RoleCode } from '@prisma/client';
import { createRequire } from 'node:module';

import { PrismaService as PrismaServiceToken } from '../src/core/prisma/prisma.service';
import { BCRYPT_HASH_ROUNDS } from '../src/modules/auth/auth.constants';
import { RegisterDto } from '../src/modules/auth/dto/register.dto';
import type { PrismaService } from '../src/core/prisma/prisma.service';
import { UsersService as UsersServiceToken } from '../src/modules/users/users.service';
import type { UsersService } from '../src/modules/users/users.service';

export interface CounselorProvisioningInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  username?: string;
  phone?: string;
}

export type ProvisioningDependencies = {
  prisma: Pick<PrismaService, 'role'>;
  usersService: Pick<UsersService, 'findByEmail' | 'create'>;
};

export type CounselorProvisioningResult =
  | { status: 'created'; email: string }
  | { status: 'already-provisioned'; email: string };

export function readProvisioningInput(
  env: NodeJS.ProcessEnv = process.env,
): CounselorProvisioningInput {
  const input = {
    email: env.COUNSELOR_EMAIL,
    password: env.COUNSELOR_PASSWORD,
    firstName: env.COUNSELOR_FIRST_NAME,
    lastName: env.COUNSELOR_LAST_NAME,
    username: env.COUNSELOR_USERNAME || undefined,
    phone: env.COUNSELOR_PHONE || undefined,
  };

  const validationErrors = validateSync(plainToInstance(RegisterDto, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (validationErrors.length > 0) {
    const messages = validationErrors.flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );
    throw new Error(
      `Invalid counselor provisioning configuration: ${messages.join('; ')}`,
    );
  }

  return input as CounselorProvisioningInput;
}

export async function provisionCounselor(
  input: CounselorProvisioningInput,
  { prisma, usersService }: ProvisioningDependencies,
): Promise<CounselorProvisioningResult> {
  const email = input.email.trim().toLowerCase();
  const role = await prisma.role.findFirst({
    where: { code: RoleCode.COUNSELOR, deletedAt: null },
  });

  if (!role) {
    throw new Error(
      'COUNSELOR role is missing. Run the standard role seed first.',
    );
  }

  const existingUser = await usersService.findByEmail(email);
  if (existingUser) {
    if (existingUser.role.code === RoleCode.COUNSELOR) {
      return { status: 'already-provisioned', email: existingUser.email };
    }

    throw new Error('Email is already registered to a non-counselor account.');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_HASH_ROUNDS);
  const user = await usersService.create({
    email,
    passwordHash,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    username: input.username?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
    roleId: role.id,
  });

  return { status: 'created', email: user.email };
}

async function main() {
  const input = readProvisioningInput();
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = createRequire(__filename)(
    '../src/app.module',
  ) as typeof import('../src/app.module');

  let app: INestApplicationContext | undefined;

  try {
    // Nest does not return a context when initialization rejects. PrismaService
    // cleans up its own connections in that failure path; close the context
    // here only after Nest has successfully returned one.
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });

    const result = await provisionCounselor(input, {
      prisma: app.get<PrismaService>(PrismaServiceToken),
      usersService: app.get<UsersService>(UsersServiceToken),
    });

    if (result.status === 'created') {
      console.log(`Counselor account provisioned for ${result.email}.`);
    } else {
      console.log(
        `Counselor account is already provisioned for ${result.email}; no changes made.`,
      );
    }
  } finally {
    if (app) {
      await app.close();
    }
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error &&
      (error.message.startsWith(
        'Invalid counselor provisioning configuration:',
      ) ||
        error.message.startsWith('COUNSELOR role is missing.') ||
        error.message ===
          'Email is already registered to a non-counselor account.')
        ? error.message
        : 'Counselor provisioning failed. Check database availability and the supplied configuration.';
    console.error(message);
    process.exitCode = 1;
  });
}
