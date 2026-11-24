// @ts-check
/**
 * Conversion vidéo à la demande (niveau écriture).
 * @module controllers/videoController
 */
import { SongEditError } from '../services/songEditService.js';

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/videoConvertService.js').VideoConverter} videos
 */
export function createVideoController(catalog, videos) {
  return {
    /**
     * POST /api/songs/:id/convert-video — lance la conversion en MP4 H.264.
     * Corps : `{ expectedModifiedAt: number, dryRun?: boolean }`.
     * Réponse : simulation `200 { data: { plan } }`, sinon `202 { data: { plan, job } }` :
     * la conversion continue en tâche de fond (suivre avec GET).
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async convert(req, res) {
      if (catalog.getStatus().state !== 'ready') {
        res
          .status(503)
          .json({ error: { code: 'CATALOG_LOADING', message: 'Song catalog is not ready' } });
        return;
      }
      const { expectedModifiedAt, dryRun } = req.body ?? {};
      if (
        typeof expectedModifiedAt !== 'number' ||
        (dryRun !== undefined && typeof dryRun !== 'boolean')
      ) {
        res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Expected { expectedModifiedAt: number, dryRun?: boolean }',
          },
        });
        return;
      }
      try {
        const data = await videos.start(req.params.id, { expectedModifiedAt, dryRun });
        res.status(dryRun ? 200 : 202).json({ data });
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
     * POST /api/songs/:id/extract-audio — crée le MP3 d'une chanson dont la vidéo sert aussi
     * de musique, et met à jour #AUDIO / #MP3. Corps : `{ expectedModifiedAt, dryRun? }`.
     * Réponse : `{ data: { plan, song, headers, backup } }` (simulation : rien n'est écrit).
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async extractAudio(req, res) {
      if (catalog.getStatus().state !== 'ready') {
        res
          .status(503)
          .json({ error: { code: 'CATALOG_LOADING', message: 'Song catalog is not ready' } });
        return;
      }
      const { expectedModifiedAt, dryRun } = req.body ?? {};
      if (
        typeof expectedModifiedAt !== 'number' ||
        (dryRun !== undefined && typeof dryRun !== 'boolean')
      ) {
        res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Expected { expectedModifiedAt: number, dryRun?: boolean }',
          },
        });
        return;
      }
      try {
        res.json({
          data: await videos.extractAudio(req.params.id, { expectedModifiedAt, dryRun }),
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
     * GET /api/songs/:id/convert-video — état de la dernière conversion : `{ data: { job } }`
     * (job null si aucune).
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    getJob(req, res) {
      res.json({ data: { job: videos.getJob(req.params.id) } });
    },
  };
}
