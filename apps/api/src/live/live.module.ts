import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SecurityModule } from '../auth/security.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ClientIdInterceptor } from './client-id.js';
import { LiveController } from './live.controller.js';
import { LiveHub } from './live-hub.js';
import { ListenClientFactory, PgListenClientFactory, PgListener } from './pg-listener.js';

/**
 * Live updates and presence (M10): the event stream, the per-process
 * PostgreSQL listener and the request client id. Publishing happens in
 * `AuditService.record()` and `NotificationsService.notify()`.
 */
@Module({
  imports: [SecurityModule, ProjectsModule],
  controllers: [LiveController],
  providers: [
    LiveHub,
    PgListener,
    { provide: ListenClientFactory, useClass: PgListenClientFactory },
    { provide: APP_INTERCEPTOR, useClass: ClientIdInterceptor },
  ],
  exports: [LiveHub],
})
export class LiveModule {}
