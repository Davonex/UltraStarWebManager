// @ts-check
/**
 * Construction de l'application Express (sans démarrer le serveur,
 * pour pouvoir la tester).
 * @module app
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiRouter } from './routes/api.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * @typedef {object} AppDependencies Services injectés (remplaçables dans les tests).
 * @property {import('./services/catalogService.js').Catalog} catalog
 * @property {import('./services/facetImageService.js').FacetImages} facetImages
 */

/**
 * @param {Readonly<import('./config/index.js').AppConfig>} _config
 * @param {AppDependencies} deps
 * @returns {import('express').Express}
 */
export function createApp(_config, deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createApiRouter(deps));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Unknown API route' } });
  });

  app.use(express.static(publicDir));

  app.use(errorHandler);

  return app;
}

/**
 * Gestionnaire d'erreurs central : journalise, puis répond sans détail technique.
 * Express 5 y transmet aussi les promesses rejetées des contrôleurs.
 *
 * @param {unknown} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function errorHandler(err, _req, res, _next) {
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
