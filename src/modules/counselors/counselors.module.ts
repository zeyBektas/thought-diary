import { Module } from '@nestjs/common';
import { AdminCounselorsController } from './admin-counselors.controller';
import { CounselorApplicationsController } from './counselor-applications.controller';
import { CounselorProfilesService } from './counselor-profiles.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';

@Module({
  controllers: [CounselorApplicationsController, AdminCounselorsController],
  providers: [CounselorProfilesService, PlatformAdminGuard],
})
export class CounselorsModule {}
