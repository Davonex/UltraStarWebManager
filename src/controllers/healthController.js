// @ts-check
/** @module controllers/healthController */

/**
 * GET /api/health — vérifie que le serveur répond.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
export function getHealth(_req, res) {
  res.json({ status: 'ok', version: process.env.npm_package_version ?? null });
}
