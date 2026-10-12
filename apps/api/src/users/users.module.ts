import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SecurityModule } from '../auth/security.module.js';
import { AdminUsersController } from './admin-users.controller.js';
import { MeController } from './me.controller.js';
import { UsersService } from './users.service.js';

/** Admin user management, the caller's profile, and the admin bootstrap. */
@Module({
  imports: [SecurityModule, AuditModule],
  controllers: [AdminUsersController, MeController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
