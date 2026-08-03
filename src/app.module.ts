import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { DiariesModule } from './modules/diaries/diaries.module';
import { PrismaModule } from './core/prisma/prisma.module';
import { configuration, validationSchema } from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
    }),

    PrismaModule,

    AuthModule,
    UsersModule,
    DiariesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
