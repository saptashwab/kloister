import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AnnotationsModule } from './annotations/annotations.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BackupsModule } from './backups/backups.module.js';
import { BoardModule } from './board/board.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { ItemsModule } from './items/items.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { AdminSettingsModule } from './settings/admin-settings.module.js';
import { UsersModule } from './users/users.module.js';

/**
 * Root module. Feature modules are added here as each milestone lands.
 * `AuthModule` registers the global CSRF and session guards,
 * so every route requires a session unless marked `@Public()`.
 * `ScheduleModule` runs the daily jobs (due-date notifications, unused
 * inline images, backups, log clean-up) in this process; nothing calls out
 * to other hosts.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule,
    LoggingModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    AuditModule,
    ProjectsModule,
    BoardModule,
    ItemsModule,
    AnnotationsModule,
    NotificationsModule,
    AdminSettingsModule,
    BrandingModule,
    BackupsModule,
    HealthModule,
  ],
})
export class AppModule {}
