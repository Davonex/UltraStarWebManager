// @ts-check
/** @module controllers/healthController */
import { APP_VERSION } from '../config/index.js';

/**
 * GET /api/health — vérifie que le serveur répond.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
export function getHealth(_req, res) {
  res.json({ status: 'ok', version: APP_VERSION });
}
