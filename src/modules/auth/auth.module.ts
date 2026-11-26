import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { SignOptions } from 'jsonwebtoken';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaModule } from '@/core/prisma/prisma.module';
import { MailDeliveryModule } from '@/core/mail/mail-delivery.module';
import { UsersModule } from '../users/users.module';
import { DiariesModule } from '../diaries/diaries.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { EmailVerificationController } from './email-verification.controller';
import { EmailVerificationService } from './email-verification.service';

@Module({
  controllers: [AuthController, EmailVerificationController],
  providers: [AuthService, JwtStrategy, EmailVerificationService],
  imports: [
    PrismaModule,
    MailDeliveryModule,
    UsersModule,
    DiariesModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>(
            'JWT_ACCESS_EXPIRES_IN',
            '15m',
          ) as SignOptions['expiresIn'],
        },
      }),
    }),
  ],
})
export class AuthModule {}
