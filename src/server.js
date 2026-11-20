// @ts-check
/**
 * Point d'entrée : charge la configuration, le catalogue, puis démarre le serveur HTTP.
 * @module server
 */
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createCatalog } from './services/catalogService.js';
import { createFacetImages } from './services/facetImageService.js';

const config = loadConfig();
const catalog = createCatalog({ songDir: config.songDir });
const facetImages = createFacetImages({ dir: config.categoryCoversDir });
await facetImages.load();

if (config.songDir) {
  await catalog.load();
} else {
  console.warn('SONG_DIR is not set: copy .env.example to .env');
}

const app = createApp(config, { catalog, facetImages });

const server = app.listen(config.port, config.host, () => {
  console.info(`UltraStarWebManager listening on http://${config.host}:${config.port}`);
});

/** Arrêt propre (Ctrl+C). */
function shutdown() {
  console.info('Shutting down…');
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
