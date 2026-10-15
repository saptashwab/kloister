import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { format, resolveConfig } from 'prettier';
import { AppModule } from '../app.module.js';
import { configureApp, createAdapter } from '../app.factory.js';

// Build-time only: construct metadata without app.init(), listen(), scheduled
// jobs or database queries. Never mount Swagger UI or a document HTTP endpoint.
process.env['DATABASE_URL'] = 'postgresql://documentation:documentation@127.0.0.1:1/documentation';
process.env['NODE_ENV'] = 'development';
delete process.env['LOG_DIR'];
const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(false), {
  logger: false,
});
try {
  await configureApp(app);
  const config = new DocumentBuilder()
    .setTitle('Kloister API')
    .setVersion(process.env['RELEASE_VERSION'] ?? 'development')
    .setDescription(
      'Session cookie authentication; state-changing requests require X-Requested-With: kloister. ' +
        'Authorization is enforced by the API. Hidden items return 404. ' +
        'See SPEC sections 3–5 for role and visibility rules. Binary file routes are documented by their controllers.',
    )
    .addCookieAuth('sid')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // Authentication remains the runtime guards' responsibility. Describe their
  // existing default and the small public allow-list without serving a UI.
  document.security = [{ cookie: [] }];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = item[method];
      if (operation === undefined) continue;
      if (
        path === '/api/v1/health' ||
        path === '/api/v1/auth/login' ||
        path.startsWith('/api/v1/branding')
      ) {
        operation.security = [];
      }
      if (['post', 'put', 'patch', 'delete'].includes(method)) {
        operation.parameters = [
          ...(operation.parameters ?? []),
          {
            name: 'X-Requested-With',
            in: 'header',
            required: true,
            schema: { type: 'string', enum: ['kloister'] },
            description: 'Required by the CSRF guard, including sign-in.',
          },
        ];
      }
    }
  }
  const output = resolve(process.argv[2] ?? '../../docs/openapi.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    await format(JSON.stringify(document), { ...(await resolveConfig(output)), parser: 'json' }),
    'utf8',
  );
} finally {
  await app.close();
}
