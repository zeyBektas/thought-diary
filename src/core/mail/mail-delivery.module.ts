import { Module, ServiceUnavailableException } from '@nestjs/common';

export type MailMessage =
  | {
      purpose: 'ORGANIZATION_INVITATION';
      to: string;
      token: string;
      organizationName: string;
      invitationType: 'CLIENT' | 'COUNSELOR';
      expiresAt: Date;
    }
  | {
      purpose: 'EMAIL_VERIFICATION';
      to: string;
      token: string;
      expiresAt: Date;
    };

export abstract class MailDelivery {
  // Resolve only after the provider has accepted this message. Adapters must
  // honor cancellation and must not log or return the message or its token.
  abstract send(message: MailMessage, signal: AbortSignal): Promise<void>;
}

export async function deliver(mail: MailDelivery, message: MailMessage) {
  const signal = AbortSignal.timeout(3_000);
  try {
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error('Email delivery timed out')),
        { once: true },
      );
      void Promise.resolve()
        .then(() => mail.send(message, signal))
        .then(resolve, reject);
    });
  } catch {
    // Do not pass provider errors to the HTTP layer or logger; they may carry
    // the recipient, message body or provider credentials.
    throw new ServiceUnavailableException('Email delivery is unavailable');
  }
}

@Module({
  providers: [
    {
      provide: MailDelivery,
      useValue: {
        send: () => Promise.reject(new Error('No email provider configured')),
      } satisfies MailDelivery,
    },
  ],
  exports: [MailDelivery],
})
export class MailDeliveryModule {}
