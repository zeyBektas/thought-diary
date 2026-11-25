import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { RoleCode } from '@prisma/client';
import { type CurrentUser, hasCurrentRole } from '../../users/users.service';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUser }>();
    if (!user || !hasCurrentRole(user, RoleCode.PLATFORM_ADMIN)) {
      throw new ForbiddenException('Platform Admin role required');
    }
    return true;
  }
}
