// @ts-check
/**
 * Recherche d'informations sur MusicBrainz pour une chanson (niveau écriture : sert à
 * corriger #YEAR, #GENRE et #LANGUAGE ; l'enregistrement passe par PATCH /headers).
 * @module controllers/musicBrainzController
 */
import { MBID_PATTERN } from '../parsers/musicBrainz.js';
import { MusicBrainzError } from '../services/musicBrainzService.js';

const SONG_NOT_FOUND = Object.freeze({ code: 'SONG_NOT_FOUND', message: 'Song not found' });

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/musicBrainzService.js').MusicBrainz} musicBrainz
 */
export function createMusicBrainzController(catalog, musicBrainz) {
  /**
   * @param {import('express').Response} res
   * @param {unknown} error
   */
  function sendError(res, error) {
    if (!(error instanceof MusicBrainzError)) throw error;
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }

  return {
    /**
     * GET /api/songs/:id/musicbrainz — enregistrements correspondant à l'artiste et au titre.
     * Réponse : `{ data: { candidates: MbCandidate[] } }`.
     *
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async search(req, res) {
      const song = catalog.getSong(req.params.id);
      if (!song) {
        res.status(404).json({ error: SONG_NOT_FOUND });
        return;
      }
      if (!song.artist || !song.title) {
        res.status(422).json({
          error: { code: 'MUSICBRAINZ_NO_QUERY', message: 'Artist and title are needed to search' },
        });
        return;
      }
      try {
        res.json({ data: { candidates: await musicBrainz.search(song.artist, song.title) } });
      } catch (error) {
        sendError(res, error);
      }
    },

    /**
     * GET /api/songs/:id/musicbrainz/:recordingId?artistId=…&releaseGroupId=… — valeurs
     * proposées (année, langues, genres) pour l'enregistrement choisi.
     * Réponse : `{ data: { suggestion: MbSuggestion } }`.
     *
     * @param {import('express').Request<{ id: string, recordingId: string }>} req
     * @param {import('express').Response} res
     */
    async suggest(req, res) {
      if (!catalog.getSong(req.params.id)) {
        res.status(404).json({ error: SONG_NOT_FOUND });
        return;
      }
      const { artistId, releaseGroupId } = req.query;
      /** @param {unknown} value */
      const optionalId = (value) => (value === undefined || value === '' ? null : value);
      const ids = [req.params.recordingId, optionalId(artistId), optionalId(releaseGroupId)];
      // Identifiants vérifiés : ils sont insérés dans l'URL appelée sur MusicBrainz.
      if (ids.some((id) => id !== null && (typeof id !== 'string' || !MBID_PATTERN.test(id)))) {
        res
          .status(400)
          .json({ error: { code: 'INVALID_REQUEST', message: 'Invalid MusicBrainz id' } });
        return;
      }
      try {
        const suggestion = await musicBrainz.suggest(req.params.recordingId, {
          artistId: /** @type {string | null} */ (ids[1]),
          releaseGroupId: /** @type {string | null} */ (ids[2]),
        });
        res.json({ data: { suggestion } });
      } catch (error) {
        sendError(res, error);
      }
    },
  };
}
