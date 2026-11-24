// @ts-check
/**
 * Routes de l'API. Règle : une route ne fait qu'associer une URL à un contrôleur,
 * précédé du niveau d'accès exigé (`requireRole`).
 *
 * Niveaux : read (consulter, écouter) < write (modifier) < admin (supprimer).
 *
 * @module routes/api
 */
import { Router } from 'express';
import { createAuthController } from '../controllers/authController.js';
import { createBulkController } from '../controllers/bulkController.js';
import { createFacetImagesController } from '../controllers/facetImagesController.js';
import { getHealth } from '../controllers/healthController.js';
import { createMusicBrainzController } from '../controllers/musicBrainzController.js';
import { createPlaylistsController } from '../controllers/playlistsController.js';
import { createRenameController } from '../controllers/renameController.js';
import { createReplayGainController } from '../controllers/replayGainController.js';
import { createSettingsController } from '../controllers/settingsController.js';
import { createSongsController } from '../controllers/songsController.js';
import { createVideoController } from '../controllers/videoController.js';
import { requireRole } from '../middlewares/auth.js';

/**
 * @param {object} deps
 * @param {import('../services/catalogService.js').Catalog} deps.catalog
 * @param {import('../services/facetImageService.js').FacetImages} deps.facetImages
 * @param {import('../services/authService.js').Auth} deps.auth
 * @param {import('../services/songEditService.js').SongEditor} deps.editor
 * @param {import('../services/videoConvertService.js').VideoConverter} deps.videos
 * @param {import('../services/playlistService.js').Playlists} deps.playlists
 * @param {import('../services/musicBrainzService.js').MusicBrainz} deps.musicBrainz
 * @param {import('../services/replayGainService.js').ReplayGainTool} deps.replayGain
 * @param {import('../services/settingsService.js').SettingsStore} deps.settings
 * @param {import('../services/renameService.js').Renamer} deps.renamer
 * @returns {import('express').Router}
 */
export function createApiRouter({
  catalog,
  facetImages,
  auth,
  editor,
  videos,
  playlists,
  musicBrainz,
  replayGain,
  settings,
  renamer,
}) {
  const router = Router();
  const songs = createSongsController(catalog, editor, videos);
  const video = createVideoController(catalog, videos);
  const bulk = createBulkController(catalog, editor, videos);
  const images = createFacetImagesController(facetImages);
  const playlistsCtl = createPlaylistsController(catalog, playlists);
  const mb = createMusicBrainzController(catalog, musicBrainz);
  const gain = createReplayGainController(catalog, replayGain);
  const preferences = createSettingsController(catalog, settings);
  const renames = createRenameController(catalog, renamer);
  const session = createAuthController(auth);
  const read = requireRole('read');

  // Publiques : santé et connexion
  router.get('/health', getHealth);
  router.get('/auth/me', session.me);
  router.post('/auth/login', session.login);
  router.post('/auth/logout', session.logout);

  // Lecture
  router.get('/songs', read, songs.listSongs);
  router.get('/songs/:id', read, songs.getSong);
  router.get('/songs/:id/cover', read, songs.getCover);
  router.get('/songs/:id/audio', read, songs.getAudio);
  router.get('/songs/:id/video', read, songs.getVideo);
  router.get('/facet-images', read, images.listImages);
  router.get('/facet-images/:facet/:value', read, images.getImage);
  router.get('/playlists', read, playlistsCtl.listPlaylists);
  router.get('/settings', read, preferences.get);

  // Écriture
  const write = requireRole('write');
  router.post('/catalog/rescan', write, songs.rescan);
  router.patch('/songs/:id/headers', write, songs.editHeaders);
  router.post('/songs/:id/convert-utf8', write, songs.convertToUtf8);
  router.post('/songs/:id/convert-video', write, video.convert);
  // Playlists : ajout / retrait d'une chanson (sauvegarde datée, écriture atomique)
  router.post('/playlists/:file/songs', write, playlistsCtl.addSong);
  router.delete('/playlists/:file/songs', write, playlistsCtl.removeSong);
  router.get('/songs/:id/convert-video', write, video.getJob);
  router.post('/songs/:id/extract-audio', write, video.extractAudio);
  router.post('/songs/:id/replaygain', write, gain.replayGain);
  router.post('/songs/:id/rename', write, renames.rename);
  router.post('/renames/:journal/undo', write, renames.undo);
  // MusicBrainz (YEAR, GENRE, LANGUAGE) : recherche, puis valeurs proposées ; écriture par PATCH /headers
  router.get('/songs/:id/musicbrainz', write, mb.search);
  router.get('/songs/:id/musicbrainz/:recordingId', write, mb.suggest);

  // Corrections en masse (écriture) : simulation puis application
  router.post('/bulk/convert-utf8', write, bulk.convertToUtf8);
  router.post('/bulk/convert-video', write, bulk.convertVideos);
  router.get('/bulk/convert-video', write, bulk.getVideoBatch);
  router.post('/bulk/convert-video/stop', write, bulk.stopVideoBatch);

  // Administration : préférences communes à tous (modèles de nommage…)
  router.put('/settings', requireRole('admin'), preferences.update);

  return router;
}
