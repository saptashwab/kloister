import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestApplicationOptions } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { API_PREFIX } from '@kloister/shared';
import { AppModule } from './app.module.js';

/**
 * Creates the Nest application on the Fastify adapter with all global setup
 * applied (route prefix today; pipes, filters and guards in later milestones).
 *
 * Both `main.ts` and the e2e tests call this, so tests exercise exactly the
 * configuration that runs in production.
 *
 * @param options Nest options; tests pass `{ logger: false }` to keep output quiet.
 * @returns An initialised but not yet listening application.
 */
export async function createApp(
  options: NestApplicationOptions = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    options,
  );
  app.setGlobalPrefix(API_PREFIX);
  await app.init();
  return app;
}
