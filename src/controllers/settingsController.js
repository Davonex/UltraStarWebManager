// @ts-check
/**
 * Préférences de l'application (modèles de nommage…).
 * @module controllers/settingsController
 */
import { defaultSettings } from '../services/settingsService.js';
import { SongEditError } from '../services/songEditService.js';

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/settingsService.js').SettingsStore} settings
 */
export function createSettingsController(catalog, settings) {
  return {
    /**
     * GET /api/settings — préférences en cours, et valeurs par défaut :
     * `{ data: Settings, meta: { defaults: Settings } }`.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    get(_req, res) {
      res.json({ data: settings.get(), meta: { defaults: defaultSettings() } });
    },

    /**
     * PUT /api/settings — enregistre les préférences (niveau admin), puis relit la
     * bibliothèque pour mettre les avertissements à jour : `{ data: Settings }`.
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    async update(req, res) {
      try {
        const saved = await settings.save(req.body);
        await catalog.load();
        res.json({ data: saved });
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
  };
}
