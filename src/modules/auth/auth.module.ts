import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaModule } from '@/core/prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { DiariesModule } from '../diaries/diaries.module';

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  imports: [PrismaModule, AuthModule, UsersModule, DiariesModule],
})
export class AuthModule {}
