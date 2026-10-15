import { createServer, request, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, USERS } from './support';

// CI-only: serve the packaged production frontend under a non-root prefix.
// The proxy is a disposable test harness, not another deployment option.
const prefix = '/deployment-check/';
const origin = 'http://localhost:4201';
const frontend = resolve('../../dist/ci-release/payload/frontend');
let server: Server;

test.beforeAll(async () => {
  server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', origin);
    if (url.pathname.startsWith(`${prefix}api/`)) {
      const proxied = request(
        {
          hostname: '127.0.0.1',
          port: 3000,
          path: url.pathname.slice(prefix.length - 1) + url.search,
          method: incoming.method,
          headers: incoming.headers,
        },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      proxied.on('error', () => {
        response.writeHead(502);
        response.end();
      });
      incoming.pipe(proxied);
      return;
    }
    // Contain paths and return the same SPA fallback as the scoped httpd config.
    void (async () => {
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      const file = resolve(frontend, relative || 'index.html');
      if (!file.startsWith(frontend + sep)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const extension = extname(file);
      const html = extension === '' || extension === '.html';
      const body = html
        ? (await readFile(resolve(frontend, 'index.html'), 'utf8')).replaceAll(
            '/__KLOISTER_BASE__/',
            prefix,
          )
        : await readFile(file);
      const mime: Record<string, string> = {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.json': 'application/json',
      };
      response.setHeader(
        'Content-Type',
        html ? 'text/html' : (mime[extension] ?? 'application/octet-stream'),
      );
      response.end(body);
    })().catch(() => {
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(4201, '127.0.0.1', done);
  });
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
});

test('packaged frontend loads assets, API and direct drawer links below a non-root prefix', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    // Initial session discovery on the sign-in page legitimately returns 401.
    if (
      response.status() >= 400 &&
      !(response.status() === 401 && response.url().endsWith('/api/v1/me'))
    )
      failures.push(response.url());
  });
  await page.goto(`${origin}${prefix}login`);
  await page.getByLabel('Email').fill(USERS.pm);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  const login = page.waitForResponse((response) =>
    response.url().endsWith(`${prefix}api/v1/auth/login`),
  );
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await login).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.goto(`${origin}${prefix}p/KLO/items/4`);
  await expect(page.locator('app-item-drawer').getByRole('heading', { level: 1 })).toBeVisible();
  await expect(
    page.locator('app-item-drawer').getByRole('button', { name: 'Duplicate item', exact: true }),
  ).toBeVisible();
  expect(await page.locator('base').getAttribute('href')).toBe(prefix);
  // A successful full reload proves routing does not depend on dev-server state.
  await page.reload();
  await expect(page.locator('app-item-drawer').getByRole('heading', { level: 1 })).toBeVisible();
  expect(failures).toEqual([]);
  await test.info().attach('packaged frontend below non-root prefix', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
