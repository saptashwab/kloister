import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ItemsModule } from '../items/items.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AdoController } from './ado.controller.js';
import { AdoService } from './ado.service.js';

/** Offline project transfers reuse ordinary project and item checks; no network client is registered. */
@Module({
  imports: [AuditModule, ProjectsModule, ItemsModule],
  controllers: [AdoController],
  providers: [AdoService],
})
export class AdoModule {}
