import { createApp } from './app.factory.js';
import { AppConfig } from './config/app-config.js';

/**
 * Process entry point: builds the app and starts listening.
 *
 * Host and port come from the environment (written to `kloister.env` by the
 * install script). The default host is loopback because httpd is the only
 * intended client; it reverse-proxies `/<app_name>/api/` to this port.
 */
async function bootstrap(): Promise<void> {
  const app = await createApp();
  app.enableShutdownHooks();
  const config = app.get(AppConfig);
  await app.listen(config.port, config.host);
}

await bootstrap();
