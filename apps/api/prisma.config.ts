import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (generate, migrate).
 *
 * `DATABASE_URL` comes from the environment (`kloister.env` on the server, a
 * service container in CI). It may be empty for `prisma generate`, which does
 * not connect to a database.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] ?? '' },
});
