// @ts-check
/**
 * Point d'entrée : charge la configuration, le catalogue, puis démarre le serveur HTTP.
 * @module server
 */
import os from 'node:os';
import { createApp } from './app.js';
import { isLoopbackHost, loadConfig } from './config/index.js';
import { createCatalog } from './services/catalogService.js';
import { createFacetImages } from './services/facetImageService.js';
import { createSettings } from './services/settingsService.js';

const config = loadConfig();
// Préférences d'abord : le catalogue en a besoin (modèles de nommage des avertissements).
const settings = createSettings({ file: config.settingsFile });
await settings.load();
const catalog = createCatalog({
  songDir: config.songDir,
  getNaming: () => settings.get().naming,
});
const facetImages = createFacetImages({ dir: config.categoryCoversDir });
await facetImages.load();

if (config.songDir) {
  await catalog.load();
} else {
  console.warn('SONG_DIR is not set: copy .env.example to .env');
}

const app = createApp(config, { catalog, facetImages, settings });

const server = app.listen(config.port, config.host, () => {
  console.info(`UltraStarWebManager listening on http://${config.host}:${config.port}`);
  if (!isLoopbackHost(config.host)) {
    // Ouvert au réseau local : adresses à utiliser depuis les autres appareils
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const { address, family, internal } of addresses ?? []) {
        if (family === 'IPv4' && !internal)
          console.info(`  Network: http://${address}:${config.port}`);
      }
    }
    const roles = Object.entries(config.accessKeys)
      .filter(([, key]) => key !== null)
      .map(([role]) => role);
    console.info(`  Access keys configured: ${roles.join(', ')}`);
  }
});

/** Arrêt propre (Ctrl+C). */
function shutdown() {
  console.info('Shutting down…');
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
