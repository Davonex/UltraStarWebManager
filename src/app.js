// @ts-check
/**
 * Construction de l'application Express (sans démarrer le serveur,
 * pour pouvoir la tester).
 * @module app
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuthController } from './controllers/authController.js';
import { createIdentify } from './middlewares/auth.js';
import { allowedHostnames, apiGuard, createHostGuard } from './middlewares/requestGuard.js';
import { securityHeaders } from './middlewares/securityHeaders.js';
import { createApiRouter } from './routes/api.js';
import { createAuth } from './services/authService.js';
import { createFfmpeg } from './services/ffmpegService.js';
import { createMusicBrainz } from './services/musicBrainzService.js';
import { createPlaylists } from './services/playlistService.js';
import { createRenamer } from './services/renameService.js';
import { createReplayGainTool } from './services/replayGainService.js';
import { createSettings } from './services/settingsService.js';
import { createSongEditor } from './services/songEditService.js';
import { createVideoConverter } from './services/videoConvertService.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
/** Bootstrap est servi depuis node_modules (plus de CDN : CSP stricte, fonctionne hors ligne). */
const bootstrapDir = path.join(
  path.dirname(createRequire(import.meta.url).resolve('bootstrap/package.json')),
  'dist',
);

/**
 * @typedef {object} AppDependencies Services injectés (remplaçables dans les tests).
 * @property {import('./services/catalogService.js').Catalog} catalog
 * @property {import('./services/facetImageService.js').FacetImages} facetImages
 * @property {import('./services/ffmpegService.js').Ffmpeg} [ffmpeg]  Par défaut : FFMPEG_PATH.
 * @property {import('./services/playlistService.js').Playlists} [playlists]  Par défaut : PLAYLIST_DIR.
 * @property {import('./services/musicBrainzService.js').MusicBrainz} [musicBrainz]  Par défaut : API publique.
 * @property {import('./services/settingsService.js').SettingsStore} [settings]  Par défaut : SETTINGS_FILE
 *   (non relu ici : server.js le charge avant le catalogue).
 */

/**
 * @param {Readonly<import('./config/index.js').AppConfig>} config
 * @param {AppDependencies} deps
 * @returns {import('express').Express}
 */
export function createApp(config, deps) {
  const auth = createAuth({ accessKeys: config.accessKeys, sessionDays: config.sessionDays });
  const editor = createSongEditor({ catalog: deps.catalog, backupDir: config.backupDir });
  const ffmpeg = deps.ffmpeg ?? createFfmpeg({ ffmpegPath: config.ffmpegPath });
  const videos = createVideoConverter({
    catalog: deps.catalog,
    editor,
    ffmpeg,
    backupDir: config.backupDir,
  });
  const replayGain = createReplayGainTool({
    catalog: deps.catalog,
    ffmpeg,
    backupDir: config.backupDir,
  });
  const settings = deps.settings ?? createSettings({ file: config.settingsFile });
  const renamer = createRenamer({
    catalog: deps.catalog,
    songDir: config.songDir,
    backupDir: config.backupDir,
    getNaming: () => settings.get().naming,
  });
  const app = express();
  app.disable('x-powered-by');

  // 1. Sécurité, pour toutes les requêtes
  app.use(securityHeaders);
  app.use(createHostGuard(allowedHostnames(config)));
  app.use(express.json({ limit: '1mb' }));
  app.use(
    createIdentify({ auth, trustLocalhost: config.trustLocalhost, publicRead: config.publicRead }),
  );

  // 2. Lien de connexion (/login?key=…) et API
  app.get('/login', createAuthController(auth).loginLink);
  app.use(
    '/api',
    apiGuard,
    createApiRouter({
      ...deps,
      playlists:
        deps.playlists ??
        createPlaylists({
          playlistDir: config.playlistDir,
          catalog: deps.catalog,
          backupDir: config.backupDir,
        }),
      musicBrainz: deps.musicBrainz ?? createMusicBrainz(),
      auth,
      editor,
      videos,
      replayGain,
      settings,
      renamer,
    }),
  );
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Unknown API route' } });
  });

  // 3. Interface (publique : la page de connexion doit pouvoir s'afficher)
  app.use('/vendor/bootstrap', express.static(bootstrapDir, { maxAge: '7d' }));
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
  const status = /** @type {{ status?: number }} */ (err)?.status;
  if (status === 400 || status === 413) {
    // Corps JSON invalide ou trop gros (express.json)
    res
      .status(status)
      .json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request body' } });
    return;
  }
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  if (code && ['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
    // Fichier verrouillé ou en lecture seule : message clair plutôt qu'une erreur interne.
    console.warn(`File locked or read-only (${code}): ${/** @type {Error} */ (err).message}`);
    res.status(423).json({
      error: { code: 'FILE_LOCKED', message: 'The file is locked or read-only' },
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
