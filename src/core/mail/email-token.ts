import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const isEmailToken = (token: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(token);
export const hashEmailToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export function newEmailToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashEmailToken(token) };
}

export function matchesEmailTokenHash(hash: string, stored: string) {
  if (!/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored, 'hex'));
}

// Wall-clock time after waiting on locks, not PostgreSQL transaction start time.
export async function databaseNow(tx: Prisma.TransactionClient) {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now
  `;
  return now;
}

type EmailAccount = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
};

export async function lockActiveEmailAccount(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const [account] = await tx.$queryRaw<EmailAccount[]>`
    SELECT id, email, "emailVerifiedAt" FROM users
    WHERE id = ${userId} AND status = 'ACTIVE' AND "deletedAt" IS NULL
    FOR NO KEY UPDATE
  `;
  return account;
}
