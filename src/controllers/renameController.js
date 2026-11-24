// @ts-check
/**
 * Renommage d'un dossier de chanson selon les normes de nommage (simulation, application,
 * annulation).
 * @module controllers/renameController
 */
import { SongEditError } from '../services/songEditService.js';

const INVALID_REQUEST = Object.freeze({ code: 'INVALID_REQUEST', message: 'Invalid request body' });
const NOT_READY = Object.freeze({ code: 'CATALOG_LOADING', message: 'Song catalog is loading' });
/** Bornes des données reçues. */
const MAX_FILES = 500;
const MAX_NAME_LENGTH = 255;

/**
 * Valeur de type objet simple (pas un tableau).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Noms saisis : `{ folder?: string, files?: { [nom actuel]: nouveau nom } }`.
 * @param {unknown} value
 * @returns {{ folder?: string, files?: Record<string, string> } | null}  null : invalide.
 */
function parseOverrides(value) {
  if (value === undefined) return {};
  if (!isObject(value)) return null;
  const { folder, files } = value;
  if (folder !== undefined && (typeof folder !== 'string' || folder.length > MAX_NAME_LENGTH)) {
    return null;
  }
  if (files === undefined) return { folder };
  if (!isObject(files) || Object.keys(files).length > MAX_FILES) return null;
  for (const [from, to] of Object.entries(files)) {
    if (from.length > MAX_NAME_LENGTH || typeof to !== 'string' || to.length > MAX_NAME_LENGTH) {
      return null;
    }
  }
  return { folder, files: /** @type {Record<string, string>} */ (files) };
}

/**
 * État vu lors de la simulation : `{ listing: string, txts: { [nom]: date } }`.
 * @param {unknown} value
 * @returns {import('../services/renameService.js').RenameExpected | null}
 */
function parseExpected(value) {
  if (!isObject(value) || typeof value.listing !== 'string' || !isObject(value.txts)) return null;
  if (!Object.values(value.txts).every((v) => typeof v === 'number')) return null;
  return {
    listing: value.listing,
    txts: /** @type {Record<string, number>} */ (value.txts),
  };
}

/**
 * @param {import('express').Response} res
 * @param {unknown} error
 */
function sendError(res, error) {
  if (!(error instanceof SongEditError)) throw error;
  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.params ? { params: error.params } : {}),
    },
  });
}

/**
 * @param {import('../services/catalogService.js').Catalog} catalog
 * @param {import('../services/renameService.js').Renamer} renamer
 */
export function createRenameController(catalog, renamer) {
  return {
    /**
     * POST /api/songs/:id/rename
     * - `{ dryRun: true, overrides? }` → `{ data: plan }` (rien n'est écrit) ;
     * - `{ overrides?, expected }` → `{ data: { songId, journal, renamed, backups } }`.
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     */
    async rename(req, res) {
      if (catalog.getStatus().state !== 'ready') {
        res.status(503).json({ error: NOT_READY });
        return;
      }
      const body = req.body ?? {};
      const overrides = parseOverrides(body.overrides);
      if (!overrides || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')) {
        res.status(400).json({ error: INVALID_REQUEST });
        return;
      }
      try {
        if (body.dryRun) {
          res.json({ data: await renamer.preview(req.params.id, { overrides }) });
          return;
        }
        const expected = parseExpected(body.expected);
        if (!expected) {
          res.status(400).json({ error: INVALID_REQUEST });
          return;
        }
        res.json({ data: await renamer.apply(req.params.id, { overrides, expected }) });
      } catch (error) {
        sendError(res, error);
      }
    },

    /**
     * POST /api/renames/:journal/undo — annule un renommage : `{ data: { songIds } }`.
     * @param {import('express').Request<{ journal: string }>} req
     * @param {import('express').Response} res
     */
    async undo(req, res) {
      try {
        res.json({ data: await renamer.undo(req.params.journal) });
      } catch (error) {
        sendError(res, error);
      }
    },
  };
}
