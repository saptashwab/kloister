import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds a standalone release from already compiled workspace outputs.
 * @param {string} version Reviewed release version without a tag prefix.
 * @param {string} destination Empty output directory, retained for inspection.
 * @returns {Promise<string>} Path of the completed release ZIP.
 */
export async function packageRelease(version, destination) {
  // Validate paths before copying; never clean or overwrite an existing output.
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
    throw new Error('Use a semantic release version');
  }
  const output = resolve(destination);
  if (existsSync(output)) throw new Error('Output already exists; choose a fresh directory');
  const payload = join(output, 'payload');
  const backend = join(payload, 'backend');
  await mkdir(backend, { recursive: true });

  // Vendor the private shared runtime as a relative file dependency. It is
  // present in the archive, so npm never looks for a private workspace registry.
  const api = JSON.parse(await readFile(join(root, 'apps/api/package.json'), 'utf8'));
  const workspaceLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const manifest = {
    name: 'kloister-backend',
    version,
    private: true,
    type: 'module',
    license: 'MIT',
    engines: { node: '>=24.11.0 <25' },
    scripts: { start: 'node dist/main.js', 'create-admin': 'node dist/cli/create-admin.js' },
    dependencies: { ...api.dependencies, '@kloister/shared': 'file:vendor/shared' },
    overrides: workspaceLock.packages[''].overrides ?? { exceljs: { uuid: '11.1.1' } },
  };
  await writeFile(join(backend, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(root, 'apps/api/dist'), join(backend, 'dist'), {
    recursive: true,
    filter: (source) => !/[/\\]openapi\.(?:js|js\.map|d\.ts)$/.test(source),
  });
  // OpenAPI generation is a build command, not an installed backend entry point.
  await cp(join(root, 'apps/api/prisma'), join(backend, 'prisma'), { recursive: true });
  await cp(join(root, 'apps/api/prisma.config.ts'), join(backend, 'prisma.config.ts'));
  await cp(join(root, 'packages/shared/dist'), join(backend, 'vendor/shared/dist'), {
    recursive: true,
  });
  const shared = JSON.parse(await readFile(join(root, 'packages/shared/package.json'), 'utf8'));
  delete shared.scripts;
  await writeFile(join(backend, 'vendor/shared/package.json'), JSON.stringify(shared, null, 2));

  // Seed from the reviewed workspace lock. npm reconciles links offline while
  // retaining pinned registry versions and integrity hashes, never upgrading.
  const packages = { '': manifest };
  for (const [path, entry] of Object.entries(workspaceLock.packages)) {
    if (path.startsWith('node_modules/') && !entry.link) packages[path] = entry;
  }
  packages['vendor/shared'] = { ...shared, dev: false };
  packages['node_modules/@kloister/shared'] = { resolved: 'vendor/shared', link: true };
  await writeFile(
    join(backend, 'package-lock.json'),
    JSON.stringify({ name: manifest.name, version, lockfileVersion: 3, requires: true, packages }),
  );
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run through npm run package:release');
  const lock = spawnSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--offline',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: backend,
      env: { ...process.env, CHECKPOINT_DISABLE: '1', SCARF_NO_ANALYTICS: 'true' },
      encoding: 'utf8',
    },
  );
  if (lock.status !== 0) throw new Error(`Standalone lock creation failed: ${lock.stderr}`);

  // Copy only public artifacts; local helpers, source secrets and dependencies
  // cannot enter the payload through a recursive repository copy.
  await cp(join(root, 'apps/web/dist/web/browser'), join(payload, 'frontend'), { recursive: true });
  await cp(join(root, 'deploy'), join(payload, 'deploy'), { recursive: true });
  await cp(join(root, 'docs'), join(payload, 'docs'), { recursive: true });
  for (const name of ['README.md', 'LICENSE', 'SPEC.md']) {
    await cp(join(root, name), join(payload, name));
  }

  // Archive portable Unix permissions, explicitly executable Bash scripts.
  const zip = new JSZip();
  async function add(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`);
      if (entry.isDirectory()) await add(path, `${name}/`);
      else
        zip.file(name, await readFile(path), {
          unixPermissions: name.endsWith('.sh') ? 0o100755 : 0o100644,
        });
    }
  }
  await add(payload);
  const archive = join(output, `kloister-${version}.zip`);
  await writeFile(
    archive,
    await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' }),
  );
  return archive;
}

// CLI invocation keeps imports usable by verification without packaging twice.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await packageRelease(process.argv[2] ?? '1.0.0', process.argv[3] ?? 'dist/release'));
}
