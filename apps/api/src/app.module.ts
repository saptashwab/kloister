import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { UsersModule } from './users/users.module.js';

/**
 * Root module. Feature modules are added here as each milestone lands.
 * `AuthModule` registers the global CSRF and session guards,
 * so every route requires a session unless marked `@Public()`.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    AuditModule,
    ProjectsModule,
    HealthModule,
  ],
})
export class AppModule {}
