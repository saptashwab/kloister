import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { LogFiles } from './log-files.js';
import { LogRetentionJob } from './log-retention.job.js';

/**
 * Logging (SPEC §2, §9.1): pino loggers writing daily files, and the nightly
 * clean-up under the admin's retention setting. Global, so any module can
 * write to the backup log.
 */
@Global()
@Module({
  imports: [SettingsModule],
  providers: [LogFiles, LogRetentionJob],
  exports: [LogFiles],
})
export class LoggingModule {}
