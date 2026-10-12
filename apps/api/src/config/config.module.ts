import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './app-config.js';

/**
 * Provides {@link AppConfig} to every module. The environment is read once,
 * when the module is first instantiated.
 */
@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => loadConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
