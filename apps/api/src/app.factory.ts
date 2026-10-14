import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import type { NestApplicationOptions } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { API_PREFIX, UPLOAD_CONTENT_TYPE } from '@kloister/shared';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { UuidParamCasePipe } from './common/uuid.js';
import { createValidationPipe } from './common/validation.js';
import { loadConfig } from './config/app-config.js';
import { LogFiles, PinoNestLogger } from './logging/log-files.js';

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
 * prefix, error shape, DTO validation and raw upload bodies. Shared by {@link createApp} and
 * tests that build the app from a testing module.
 *
 * @param app An application that has not been initialised yet.
 * @returns Resolves once plugins are registered.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyCookie);
  // Uploads (attachments, inline images) arrive as raw bytes. The body is
  // handed on unread, so the route's guards run before any of it is read and
  // the file is streamed to disk under the admin's size limit instead of
  // being buffered (Fastify's 1 MB JSON body limit does not apply).
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(UPLOAD_CONTENT_TYPE, (_request, payload, done) => {
      done(null, payload);
    });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new AllExceptionsFilter());
  // Uuid path parameters are lowercased before validation and route pipes.
  app.useGlobalPipes(new UuidParamCasePipe(), createValidationPipe());
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
  // Unless the caller chose a logger (tests pass `false`), messages are held
  // until the pino backend log exists, then written there (SPEC §2).
  const usePino = options.logger === undefined;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(config.trustProxy),
    usePino ? { ...options, bufferLogs: true } : options,
  );
  if (usePino) app.useLogger(new PinoNestLogger(app.get(LogFiles).backend));
  await configureApp(app);
  await app.init();
  return app;
}
