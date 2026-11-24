// @ts-check
/**
 * Calcul du ReplayGain d'une chanson (niveau écriture).
 * @module controllers/replayGainController
 */
import { SongEditError } from '../services/songEditService.js';

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/replayGainService.js').ReplayGainTool} tool
 */
export function createReplayGainController(catalog, tool) {
  return {
    /**
     * POST /api/songs/:id/replaygain
     * - `{ dryRun: true }` : mesure avec ffmpeg, rien n'est écrit →
     *   `{ data: { trackGain, trackPeak, audioModifiedAt } }`
     * - `{ trackGain, trackPeak, expectedAudioModifiedAt }` : écriture dans le tag ID3 →
     *   `{ data: { song, backup } }`
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async replayGain(req, res) {
      if (catalog.getStatus().state !== 'ready') {
        res
          .status(503)
          .json({ error: { code: 'CATALOG_LOADING', message: 'Song catalog is not ready' } });
        return;
      }
      const { dryRun, trackGain, trackPeak, expectedAudioModifiedAt } = req.body ?? {};
      const writing = [trackGain, trackPeak, expectedAudioModifiedAt].every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      );
      if (dryRun !== true && !writing) {
        res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message:
              'Expected { dryRun: true } or { trackGain, trackPeak, expectedAudioModifiedAt }',
          },
        });
        return;
      }
      try {
        const data =
          dryRun === true
            ? await tool.measure(req.params.id)
            : await tool.write(req.params.id, { trackGain, trackPeak, expectedAudioModifiedAt });
        res.json({ data });
      } catch (error) {
        if (!(error instanceof SongEditError)) throw error;
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
    },
  };
}
