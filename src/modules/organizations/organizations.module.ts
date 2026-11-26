import { Module } from '@nestjs/common';
import { MailDeliveryModule } from '@/core/mail/mail-delivery.module';
import { PlatformAdminGuard } from '../counselors/guards/platform-admin.guard';
import {
  AdminOrganizationsController,
  OrganizationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationInvitationsController } from './organization-invitations.controller';
import { OrganizationInvitationsService } from './organization-invitations.service';

@Module({
  imports: [MailDeliveryModule],
  controllers: [
    OrganizationsController,
    AdminOrganizationsController,
    OrganizationInvitationsController,
  ],
  providers: [
    OrganizationsService,
    PlatformAdminGuard,
    OrganizationInvitationsService,
  ],
})
export class OrganizationsModule {}
