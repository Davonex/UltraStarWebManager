// @ts-check
/**
 * Routes de l'API. Règle : une route ne fait qu'associer une URL à un contrôleur.
 * @module routes/api
 */
import { Router } from 'express';
import { createFacetImagesController } from '../controllers/facetImagesController.js';
import { getHealth } from '../controllers/healthController.js';
import { createSongsController } from '../controllers/songsController.js';

/**
 * @param {object} deps
 * @param {import('../services/catalogService.js').Catalog} deps.catalog
 * @param {import('../services/facetImageService.js').FacetImages} deps.facetImages
 * @returns {import('express').Router}
 */
export function createApiRouter({ catalog, facetImages }) {
  const router = Router();
  const songs = createSongsController(catalog);
  const images = createFacetImagesController(facetImages);

  router.get('/health', getHealth);
  router.get('/songs', songs.listSongs);
  router.get('/songs/:id/cover', songs.getCover);
  router.get('/songs/:id/audio', songs.getAudio);
  router.get('/facet-images', images.listImages);
  router.get('/facet-images/:facet/:value', images.getImage);

  return router;
}
