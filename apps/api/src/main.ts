import { createApp } from './app.factory.js';

/**
 * Process entry point: builds the app and starts listening.
 *
 * Host and port come from the environment (written to `kloister.env` by the
 * install script). The default host is loopback because httpd is the only
 * intended client; it reverse-proxies `/<app_name>/api/` to this port.
 */
async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env['BACKEND_PORT'] ?? 3000);
  const host = process.env['BACKEND_HOST'] ?? '127.0.0.1';
  await app.listen(port, host);
}

await bootstrap();
