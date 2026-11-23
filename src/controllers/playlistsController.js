// @ts-check
/**
 * Contrôleur des playlists (.upl).
 * @module controllers/playlistsController
 */

const CATALOG_LOADING = Object.freeze({
  code: 'CATALOG_LOADING',
  message: 'Song catalog is loading',
});
const CATALOG_UNAVAILABLE = Object.freeze({
  code: 'CATALOG_UNAVAILABLE',
  message: 'Song catalog is not available',
});

import { SongEditError } from '../services/songEditService.js';

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/playlistService.js').Playlists} playlists
 */
export function createPlaylistsController(catalog, playlists) {
  /**
   * @param {'add' | 'remove'} action
   * @param {import('express').Request<{ file: string }>} req
   * @param {import('express').Response} res
   */
  async function changeSong(action, req, res) {
    if (catalog.getStatus().state !== 'ready') {
      res.status(503).json({ error: CATALOG_LOADING });
      return;
    }
    const { songId, expectedModifiedAt } = req.body ?? {};
    if (typeof songId !== 'string' || typeof expectedModifiedAt !== 'number') {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'Expected { songId, expectedModifiedAt }' },
      });
      return;
    }
    try {
      const change = action === 'add' ? playlists.addSong : playlists.removeSong;
      const { changed, backup } = await change(req.params.file, songId, expectedModifiedAt);
      const playlist = await playlists.get(req.params.file);
      res.json({ data: { playlist, changed, backup } });
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
  }

  return {
    /**
     * GET /api/playlists — playlists reliées aux chansons du catalogue.
     * Réponse : `{ data: Playlist[], meta: { configured: boolean } }`
     * (liste vide si PLAYLIST_DIR n'est pas configuré).
     * 503 tant que le catalogue n'est pas prêt (rapprochement impossible).
     *
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    async listPlaylists(_req, res) {
      const { state } = catalog.getStatus();
      if (state !== 'ready') {
        const loading = state === 'loading' || state === 'empty';
        res.status(503).json({ error: loading ? CATALOG_LOADING : CATALOG_UNAVAILABLE });
        return;
      }
      res.json({ data: await playlists.list(), meta: { configured: playlists.isConfigured() } });
    },

    /**
     * POST /api/playlists/:file/songs — ajoute une chanson. Corps : `{ songId, expectedModifiedAt }`.
     * Réponse : `{ data: { playlist, changed, backup } }`.
     *
     * @param {import('express').Request<{ file: string }>} req
     * @param {import('express').Response} res
     */
    addSong: (req, res) => changeSong('add', req, res),

    /**
     * DELETE /api/playlists/:file/songs — retire une chanson. Corps : `{ songId, expectedModifiedAt }`.
     * Réponse : `{ data: { playlist, changed, backup } }`.
     *
     * @param {import('express').Request<{ file: string }>} req
     * @param {import('express').Response} res
     */
    removeSong: (req, res) => changeSong('remove', req, res),
  };
}
