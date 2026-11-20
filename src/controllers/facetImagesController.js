// @ts-check
/**
 * Images des catégories (tuiles des filtres).
 * @module controllers/facetImagesController
 */
import path from 'node:path';

const IMAGE_MAX_AGE = '7d';
const NOT_FOUND = Object.freeze({
  code: 'FACET_IMAGE_NOT_FOUND',
  message: 'Category image not found',
});

/**
 * @param {import('../services/facetImageService.js').FacetImages} facetImages
 */
export function createFacetImagesController(facetImages) {
  return {
    /**
     * GET /api/facet-images — valeurs illustrées par facette.
     * Réponse : `{ data: { language: string[], decade: string[], edition: string[] } }`
     * (listes vides si CATEGORY_COVERS_DIR n'est pas configuré).
     *
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    listImages(_req, res) {
      res.json({ data: facetImages.list() });
    },

    /**
     * GET /api/facet-images/:facet/:value — image d'une valeur (ex. /language/French).
     *
     * @param {import('express').Request<{ facet: string, value: string }>} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    getImage(req, res, next) {
      const file = facetImages.resolve(req.params.facet, req.params.value);
      if (!file) {
        res.status(404).json({ error: NOT_FOUND });
        return;
      }
      res.sendFile(
        path.basename(file),
        {
          root: path.dirname(file),
          dotfiles: 'allow',
          maxAge: IMAGE_MAX_AGE,
          headers: { 'X-Content-Type-Options': 'nosniff' },
        },
        (error) => {
          if (!error || res.headersSent) return;
          if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
            res.status(404).json({ error: NOT_FOUND });
          } else {
            next(error);
          }
        },
      );
    },
  };
}
