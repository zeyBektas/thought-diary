import { PrismaService } from '@/core/prisma/prisma.service';
import {
  databaseNow,
  hashEmailToken,
  isEmailToken,
  lockActiveEmailAccount,
  matchesEmailTokenHash,
  newEmailToken,
} from '@/core/mail/email-token';
import { deliver, MailDelivery } from '@/core/mail/mail-delivery.module';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

const cooldown = 60_000;
const validity = 30 * 60_000;
const invalidToken = () =>
  new BadRequestException('Invalid email verification token');

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailDelivery,
  ) {}

  async request(userId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const account = await lockActiveEmailAccount(tx, userId);
        if (!account) throw new UnauthorizedException('User is not active');
        if (account.emailVerifiedAt) return { verified: true };
        const previous = await tx.emailVerificationChallenge.findUnique({
          where: { userId },
          select: { issuedAt: true },
        });
        const issuedAt = await databaseNow(tx);
        if (
          previous &&
          issuedAt.getTime() - previous.issuedAt.getTime() < cooldown
        )
          throw new HttpException(
            'A verification email was requested recently',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        const { token, tokenHash } = newEmailToken();
        const expiresAt = new Date(issuedAt.getTime() + validity);
        const fields = { email: account.email, tokenHash, issuedAt, expiresAt };
        await tx.emailVerificationChallenge.upsert({
          where: { userId },
          create: { userId, ...fields },
          update: fields,
        });
        await deliver(this.mail, {
          purpose: 'EMAIL_VERIFICATION',
          to: account.email,
          token,
          expiresAt,
        });
        return { verified: false };
      },
      { timeout: 10_000 },
    );
  }

  async confirm(userId: string, token: string) {
    if (!isEmailToken(token)) throw invalidToken();
    const hash = hashEmailToken(token);
    return this.prisma.$transaction(async (tx) => {
      const account = await lockActiveEmailAccount(tx, userId);
      if (!account) throw new UnauthorizedException('User is not active');
      const challenge = await tx.emailVerificationChallenge.findUnique({
        where: { userId },
      });
      const now = await databaseNow(tx);
      if (
        !challenge ||
        account.emailVerifiedAt ||
        challenge.email !== account.email ||
        challenge.expiresAt <= now ||
        !matchesEmailTokenHash(hash, challenge.tokenHash)
      )
        throw invalidToken();

      await tx.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: now },
      });
      await tx.emailVerificationChallenge.delete({ where: { userId } });
      return { verified: true };
    });
  }
}
