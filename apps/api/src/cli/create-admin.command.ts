import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { UsersModule } from '../users/users.module.js';
import { UsersService } from '../users/users.service.js';

/**
 * Minimal module for the CLI: database and user management only, without
 * HTTP, guards or controllers.
 */
@Module({ imports: [ConfigModule, PrismaModule, UsersModule] })
export class CliModule {}

/** Usage text printed on bad arguments. */
const USAGE = 'Usage: node dist/cli/create-admin.js --email <email> --name "<display name>"';

/**
 * Admin bootstrap command (SPEC §9.4 step 10), run by install.sh as the app
 * user with `kloister.env` loaded:
 *
 *   node dist/cli/create-admin.js --email admin@example.org --name "Admin"
 *
 * Creates the first administrator with a temporary password printed once to
 * stdout and never written to a file. Exits 0 without changes if an active
 * admin already exists, so re-running the installer is safe. Exits 2 on bad
 * arguments and 1 on any other failure.
 *
 * @param argv Command-line arguments after the script name.
 * @returns The process exit code.
 */
export async function runCreateAdmin(argv: string[]): Promise<number> {
  // Step 1: parse and check arguments before touching the database.
  let email: string;
  let name: string;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { email: { type: 'string' }, name: { type: 'string' } },
      strict: true,
    });
    email = values.email?.trim() ?? '';
    name = values.name?.trim() ?? '';
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || name === '' || name.length > 100) {
    console.error('A valid --email and a --name of 1-100 characters are required.');
    console.error(USAGE);
    return 2;
  }

  // Step 2: start a Nest context (no HTTP server) and create the admin.
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
  try {
    const result = await app.get(UsersService).bootstrapAdmin(email, name);
    // Step 3: report. The temporary password goes to stdout exactly once.
    if (result.created) {
      console.log(`Created administrator ${result.user.email}.`);
      console.log(
        `Temporary password (shown once, must be changed at first login): ${result.temporaryPassword}`,
      );
    } else {
      console.log('An active administrator already exists; nothing was changed.');
    }
    return 0;
  } catch (error) {
    console.error(
      'Failed to create the administrator:',
      error instanceof Error ? error.message : error,
    );
    return 1;
  } finally {
    await app.close();
  }
}
