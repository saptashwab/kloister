import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';

// Extract the actual ZIP into a fresh inspection folder, never test workspace
// links or the pre-archive staging tree. Keep outputs available for inspection.
const output = resolve(process.argv[2] ?? 'dist/release');
const archive = (await readdir(output)).filter((name) => /^kloister-.*\.zip$/.test(name));
assert.equal(archive.length, 1, 'Exactly one archive is required');
const extracted = join(output, `extracted-${Date.now()}`);
const zip = await JSZip.loadAsync(await readFile(join(output, archive[0])));
for (const entry of Object.values(zip.files)) {
  assert(!entry.name.split('/').includes('..') && !entry.name.startsWith('/'));
  if (entry.dir) continue;
  const target = join(extracted, entry.name);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, await entry.async('nodebuffer'));
}
const backend = join(extracted, 'backend');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run through npm run verify:release');
const env = { ...process.env, CHECKPOINT_DISABLE: '1', SCARF_NO_ANALYTICS: 'true' };

// Install using only the extracted manifest/lock/vendor payload. Offline mode
// proves cached registry packages suffice without any private workspace lookup.
const install = spawnSync(
  process.execPath,
  [npmCli, 'ci', '--omit=dev', '--offline', '--no-audit', '--no-fund'],
  {
    cwd: backend,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  },
);
assert.equal(install.status, 0, install.stderr);

// Construct Nest providers without init/listen: no scheduled jobs or queries.
// Probe argon2, shared imports, Prisma and production configuration on this OS.
const probe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
  import assert from 'node:assert/strict';
  import {hash,verify} from 'argon2';
  import {API_PREFIX} from '@kloister/shared';
  import {NestFactory} from '@nestjs/core';
  import {AppModule} from './dist/app.module.js';
  import {createAdapter,configureApp} from './dist/app.factory.js';
  assert.equal(API_PREFIX,'api/v1');
  assert(await verify(await hash('package-native-probe'),'package-native-probe'));
  const app=await NestFactory.create(AppModule,createAdapter(false),{logger:false});
  await configureApp(app);
  await app.close();
`,
  ],
  {
    cwd: backend,
    env: {
      ...env,
      NODE_ENV: 'production',
      APP_NAME: 'release_probe',
      DATABASE_URL: 'postgresql://probe:probe@127.0.0.1:1/probe',
      APP_DIR: extracted,
      ATTACHMENTS_DIR: join(extracted, 'attachments'),
      BRANDING_DIR: join(extracted, 'branding'),
      BACKUP_DIR: join(extracted, 'backups'),
      LOG_DIR: join(extracted, 'logs'),
      PG_DUMP_PATH: join(extracted, 'unused-pg-dump'),
    },
    encoding: 'utf8',
    timeout: 30_000,
  },
);
assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);

// Check the packaged CLI fails honestly before querying on invalid arguments.
const cli = spawnSync(process.execPath, ['dist/cli/create-admin.js'], {
  cwd: backend,
  env,
  encoding: 'utf8',
  timeout: 10_000,
});
assert.equal(cli.status, 2, cli.stderr);
assert(
  !(await readFile(join(extracted, 'frontend/index.html'), 'utf8')).includes('<base href="/">'),
);
console.log(`Extracted package verified without a database: ${extracted}`);
