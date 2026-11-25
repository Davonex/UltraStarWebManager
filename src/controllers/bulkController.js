// @ts-check
/**
 * Corrections en masse. Chaque outil fonctionne en deux temps :
 * 1. simulation (`dryRun: true`) : liste des fichiers concernés, rien n'est écrit ;
 * 2. application sur les éléments choisis, chacun avec la date de modification vue lors de
 *    la simulation (un fichier modifié entre-temps est ignoré, jamais écrasé).
 *
 * @module controllers/bulkController
 */
import { SongEditError } from '../services/songEditService.js';

/** Nombre maximal d'éléments traités par requête (l'interface envoie des lots). */
export const MAX_BULK_ITEMS = 200;

/**
 * @param {unknown} items
 * @returns {items is { id: string, expectedModifiedAt: number }[]}
 */
function isValidItems(items) {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= MAX_BULK_ITEMS &&
    items.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.expectedModifiedAt === 'number',
    )
  );
}

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/songEditService.js').SongEditor} editor
 * @param {import('../services/videoConvertService.js').VideoConverter} videos
 */
export function createBulkController(catalog, editor, videos) {
  /**
   * Répond 503 si le catalogue n'est pas prêt.
   * @param {import('express').Response} res
   */
  function ensureReady(res) {
    if (catalog.getStatus().state === 'ready') return true;
    res
      .status(503)
      .json({ error: { code: 'CATALOG_LOADING', message: 'Song catalog is not ready' } });
    return false;
  }

  return {
    /**
     * POST /api/bulk/convert-video — conversion des vidéos en MP4 H.264, par lot.
     *
     * - `{ dryRun: true }` → `{ data: { available, items: [{ id, artist, title, file, container,
     *   codec, width, height, size, modifiedAt }] } }`
     * - `{ items: [{ id, expectedModifiedAt }] }` (au plus 200) → `202 { data: { batch } }` :
     *   le lot est traité en tâche de fond (suivre avec GET).
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    async convertVideos(req, res) {
      if (!ensureReady(res)) return;
      const { dryRun, items } = req.body ?? {};
      if (dryRun === true) {
        res.json({ data: await videos.listCandidates() });
        return;
      }
      if (!isValidItems(items)) {
        res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: `Expected dryRun: true, or 1 to ${MAX_BULK_ITEMS} items { id, expectedModifiedAt }`,
          },
        });
        return;
      }
      try {
        const batch = await videos.startBatch(
          items.map(({ id, expectedModifiedAt }) => ({ id, expectedModifiedAt })),
        );
        res.status(202).json({ data: { batch } });
      } catch (error) {
        if (!(error instanceof SongEditError)) throw error;
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
    },

    /**
     * GET /api/bulk/convert-video — état du lot en cours ou du dernier lot : `{ data: { batch } }`.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    getVideoBatch(_req, res) {
      res.json({ data: { batch: videos.getBatch() } });
    },

    /**
     * POST /api/bulk/convert-video/stop — arrête le lot après la vidéo en cours.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    stopVideoBatch(_req, res) {
      res.json({ data: { batch: videos.stopBatch() } });
    },

    /**
     * POST /api/bulk/extract-audio — création du MP3 des vidéos qui servent aussi de musique
     * (#MP3 = #VIDEO), par lot.
     *
     * - `{ dryRun: true }` → `{ data: { available, items: [{ id, artist, title, file, target,
     *   reuse, modifiedAt }] } }`
     * - `{ items: [{ id, expectedModifiedAt }] }` (au plus 200) → `202 { data: { batch } }`.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    async extractAudio(req, res) {
      if (!ensureReady(res)) return;
      const { dryRun, items } = req.body ?? {};
      if (dryRun === true) {
        res.json({ data: await videos.listAudioCandidates() });
        return;
      }
      if (!isValidItems(items)) {
        res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: `Expected dryRun: true, or 1 to ${MAX_BULK_ITEMS} items { id, expectedModifiedAt }`,
          },
        });
        return;
      }
      try {
        const batch = await videos.startBatch(
          items.map(({ id, expectedModifiedAt }) => ({ id, expectedModifiedAt })),
          'audio',
        );
        res.status(202).json({ data: { batch } });
      } catch (error) {
        if (!(error instanceof SongEditError)) throw error;
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
    },

    /**
     * GET /api/bulk/extract-audio — état du lot de création des MP3 : `{ data: { batch } }`.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    getAudioBatch(_req, res) {
      res.json({ data: { batch: videos.getBatch('audio') } });
    },

    /**
     * POST /api/bulk/extract-audio/stop — arrête le lot après la chanson en cours.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    stopAudioBatch(_req, res) {
      res.json({ data: { batch: videos.stopBatch('audio') } });
    },

    /**
     * POST /api/bulk/convert-utf8 — convertit des fichiers en UTF-8 sans BOM.
     *
     * - `{ dryRun: true }` → `{ data: { items: [{ id, artist, title, file, from, modifiedAt }] } }`
     * - `{ items: [{ id, expectedModifiedAt }] }` (au plus 200) →
     *   `{ data: { results: [{ id, status: 'converted' | 'unchanged' | 'error', code?, backup? }] } }`
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    async convertToUtf8(req, res) {
      if (catalog.getStatus().state !== 'ready') {
        res
          .status(503)
          .json({ error: { code: 'CATALOG_LOADING', message: 'Song catalog is not ready' } });
        return;
      }
      const { dryRun, items } = req.body ?? {};

      if (dryRun === true) {
        const candidates = catalog
          .getSongs()
          .filter((song) => song.encoding !== 'utf-8')
          .map((song) => ({
            id: song.id,
            artist: song.artist,
            title: song.title,
            file: `${song.folder}/${song.txtFile}`,
            from: song.encoding,
            modifiedAt: song.modifiedAt,
          }));
        res.json({ data: { items: candidates } });
        return;
      }

      if (!isValidItems(items)) {
        res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: `Expected dryRun: true, or 1 to ${MAX_BULK_ITEMS} items { id, expectedModifiedAt }`,
          },
        });
        return;
      }

      /** @type {{ id: string, status: string, code?: string, backup?: string | null }[]} */
      const results = [];
      // Un fichier après l'autre : chacun est sauvegardé puis écrit de façon atomique.
      for (const { id, expectedModifiedAt } of items) {
        try {
          const result = await editor.convertToUtf8(id, { expectedModifiedAt });
          results.push({
            id,
            status: result.changed ? 'converted' : 'unchanged',
            backup: result.backup,
          });
        } catch (error) {
          if (!(error instanceof SongEditError)) throw error;
          results.push({ id, status: 'error', code: error.code });
        }
      }
      res.json({ data: { results } });
    },
  };
}
