import { Module } from '@nestjs/common';
import { PlatformAdminGuard } from '../counselors/guards/platform-admin.guard';
import {
  AdminOrganizationsController,
  OrganizationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [OrganizationsController, AdminOrganizationsController],
  providers: [OrganizationsService, PlatformAdminGuard],
})
export class OrganizationsModule {}
