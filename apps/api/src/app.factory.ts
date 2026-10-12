import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import type { NestApplicationOptions } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { API_PREFIX } from '@kloister/shared';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { createValidationPipe } from './common/validation.js';
import { loadConfig } from './config/app-config.js';

/**
 * Builds the Fastify adapter. `trustProxy` comes from configuration so that
 * `request.ip` is the real client address behind httpd (used for per-IP login
 * rate limiting and session records) while forwarded headers from anyone
 * other than the trusted proxy are ignored.
 *
 * @param trustProxy Addresses allowed to set `X-Forwarded-For`, or false.
 * @returns The adapter.
 */
export function createAdapter(trustProxy: string | false): FastifyAdapter {
  return new FastifyAdapter({ trustProxy });
}

/**
 * Applies the global setup every instance of the app needs: cookies, route
 * prefix, error shape and DTO validation. Shared by {@link createApp} and
 * tests that build the app from a testing module.
 *
 * @param app An application that has not been initialised yet.
 * @returns Resolves once plugins are registered.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyCookie);
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(createValidationPipe());
}

/**
 * Creates the Nest application on the Fastify adapter with all global setup
 * applied.
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
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(config.trustProxy),
    options,
  );
  await configureApp(app);
  await app.init();
  return app;
}
