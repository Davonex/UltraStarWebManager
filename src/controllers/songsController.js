// @ts-check
/**
 * Contrôleur des chansons.
 * @module controllers/songsController
 */

/** Durée de cache navigateur (l'URL contient la date de modification du .txt). */
const COVER_MAX_AGE = '7d';
const AUDIO_MAX_AGE = '1h';
const VIDEO_MAX_AGE = '1h';

/** Codes d'erreur renvoyés selon l'état du catalogue. */
const UNAVAILABLE_ERRORS = Object.freeze({
  'not-configured': { code: 'SONG_DIR_NOT_CONFIGURED', message: 'SONG_DIR is not configured' },
  error: { code: 'CATALOG_UNAVAILABLE', message: 'Song catalog could not be loaded' },
  empty: { code: 'CATALOG_LOADING', message: 'Song catalog is loading' },
  loading: { code: 'CATALOG_LOADING', message: 'Song catalog is loading' },
});

const SONG_NOT_FOUND = Object.freeze({ code: 'SONG_NOT_FOUND', message: 'Song not found' });
const COVER_NOT_FOUND = Object.freeze({ code: 'COVER_NOT_FOUND', message: 'Cover not found' });
const AUDIO_NOT_FOUND = Object.freeze({ code: 'AUDIO_NOT_FOUND', message: 'Audio file not found' });
const VIDEO_NOT_FOUND = Object.freeze({ code: 'VIDEO_NOT_FOUND', message: 'Video file not found' });

import { SongEditError } from '../services/songEditService.js';

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/songEditService.js').SongEditor} editor
 * @param {import('../services/videoConvertService.js').VideoConverter} videos
 */
export function createSongsController(catalog, editor, videos) {
  /**
   * Répond 503 si le catalogue n'est pas prêt.
   * @param {import('express').Response} res
   * @returns {boolean} true si le catalogue est prêt.
   */
  function ensureReady(res) {
    const { state } = catalog.getStatus();
    if (state === 'ready') return true;
    res.status(503).json({ error: UNAVAILABLE_ERRORS[state] });
    return false;
  }

  /**
   * Envoie un fichier de la chanson (pochette, audio…) depuis son dossier.
   *
   * @param {import('express').Request<{ id: string }>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   * @param {object} options
   * @param {keyof import('../services/catalogService.js').SongFiles} options.kind
   * @param {{ code: string, message: string }} options.notFound
   * @param {string} options.maxAge
   */
  function sendSongFile(req, res, next, { kind, notFound, maxAge }) {
    if (!ensureReady(res)) return;
    const song = catalog.getSong(req.params.id);
    if (!song) {
      res.status(404).json({ error: SONG_NOT_FOUND });
      return;
    }
    const fileName = song.files[kind];
    const folder = catalog.resolveSongFolder(song);
    if (!fileName || !folder) {
      res.status(404).json({ error: notFound });
      return;
    }
    // root = dossier de la chanson : send() refuse tout chemin qui en sortirait.
    res.sendFile(
      fileName,
      { root: folder, dotfiles: 'allow', maxAge, headers: { 'X-Content-Type-Options': 'nosniff' } },
      (error) => {
        if (!error || res.headersSent) return;
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          res.status(404).json({ error: notFound });
        } else {
          next(error);
        }
      },
    );
  }

  return {
    /**
     * GET /api/songs — liste complète des chansons (le filtrage se fait côté navigateur).
     * Réponse : `{ data: Song[], meta: { count, scannedAt, durationMs, skipped, errors } }`.
     *
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    listSongs(_req, res) {
      if (!ensureReady(res)) return;
      const status = catalog.getStatus();
      res.json({
        data: catalog.getSongs(),
        meta: {
          count: status.count,
          scannedAt: status.scannedAt,
          durationMs: status.durationMs,
          skipped: status.skipped.length,
          errors: status.errors.length,
        },
      });
    },

    /**
     * GET /api/songs/:id — détail complet d'une chanson (relit son .txt).
     * Réponse : `{ data: { song, details } }`.
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async getSong(req, res) {
      if (!ensureReady(res)) return;
      const song = catalog.getSong(req.params.id);
      if (!song) {
        res.status(404).json({ error: SONG_NOT_FOUND });
        return;
      }
      const details = await catalog.readDetails(song);
      if (!details) {
        res.status(404).json({ error: SONG_NOT_FOUND });
        return;
      }
      res.json({ data: { song, details: { ...details, video: await videos.describe(song) } } });
    },

    /**
     * PATCH /api/songs/:id/headers — modifie des en-têtes (EDITION, TAGS, CREATOR).
     * Corps : `{ values: { EDITION?: string | null, … }, expectedModifiedAt: number, dryRun?: boolean }`.
     * Réponse : `{ data: { changes, song, backup } }` (simulation : rien n'est écrit).
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async editHeaders(req, res) {
      if (!ensureReady(res)) return;
      const { values, expectedModifiedAt, dryRun } = req.body ?? {};
      if (
        values === null ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.keys(values).length === 0 ||
        typeof expectedModifiedAt !== 'number' ||
        (dryRun !== undefined && typeof dryRun !== 'boolean')
      ) {
        res
          .status(400)
          .json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request body' } });
        return;
      }
      try {
        const result = await editor.editHeaders(req.params.id, {
          values,
          expectedModifiedAt,
          dryRun,
        });
        res.json({ data: result });
      } catch (error) {
        if (!(error instanceof SongEditError)) throw error;
        res.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.params ? { params: error.params } : {}),
          },
        });
      }
    },

    /**
     * POST /api/songs/:id/convert-utf8 — convertit le fichier en UTF-8 sans BOM.
     * Corps : `{ expectedModifiedAt: number, dryRun?: boolean }`.
     * Réponse : `{ data: { changed, from, song, backup } }`.
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async convertToUtf8(req, res) {
      if (!ensureReady(res)) return;
      const { expectedModifiedAt, dryRun } = req.body ?? {};
      if (
        typeof expectedModifiedAt !== 'number' ||
        (dryRun !== undefined && typeof dryRun !== 'boolean')
      ) {
        res
          .status(400)
          .json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request body' } });
        return;
      }
      try {
        res.json({
          data: await editor.convertToUtf8(req.params.id, { expectedModifiedAt, dryRun }),
        });
      } catch (error) {
        if (!(error instanceof SongEditError)) throw error;
        res.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.params ? { params: error.params } : {}),
          },
        });
      }
    },

    /**
     * POST /api/catalog/rescan — relit tous les fichiers .txt de SONG_DIR.
     * Réponse : `{ data: { count, scannedAt, durationMs, skipped, errors } }`.
     *
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    async rescan(_req, res) {
      const status = await catalog.load();
      if (status.state !== 'ready') {
        res.status(503).json({ error: UNAVAILABLE_ERRORS[status.state] });
        return;
      }
      res.json({
        data: {
          count: status.count,
          scannedAt: status.scannedAt,
          durationMs: status.durationMs,
          skipped: status.skipped.length,
          errors: status.errors.length,
        },
      });
    },

    /**
     * GET /api/songs/:id/cover — image de pochette d'une chanson.
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    getCover(req, res, next) {
      sendSongFile(req, res, next, {
        kind: 'cover',
        notFound: COVER_NOT_FOUND,
        maxAge: COVER_MAX_AGE,
      });
    },

    /**
     * GET /api/songs/:id/audio — fichier audio complet. Les requêtes partielles (Range)
     * sont gérées : le navigateur peut se positionner directement au début de la preview.
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    getAudio(req, res, next) {
      sendSongFile(req, res, next, {
        kind: 'audio',
        notFound: AUDIO_NOT_FOUND,
        maxAge: AUDIO_MAX_AGE,
      });
    },

    /**
     * GET /api/songs/:id/video — fichier vidéo (lu sans le son par l'interface), requêtes
     * partielles (Range) gérées pour se positionner.
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    getVideo(req, res, next) {
      sendSongFile(req, res, next, {
        kind: 'video',
        notFound: VIDEO_NOT_FOUND,
        maxAge: VIDEO_MAX_AGE,
      });
    },
  };
}
