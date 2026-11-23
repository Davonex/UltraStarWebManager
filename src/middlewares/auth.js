// @ts-check
/**
 * Identification de l'utilisateur et contrôle des droits par route.
 *
 * - Requête venant de ce PC (127.0.0.1 / ::1) et TRUST_LOCALHOST actif : rôle admin.
 * - Sinon : rôle du cookie de session signé ;
 * - sans session : lecture si la lecture est publique (READ_KEY vide), sinon aucun rôle.
 *
 * Rangé dans `res.locals` : `role`, `isLocal`, `signedIn` (session valide).
 *
 * @module middlewares/auth
 */
import { hasRole } from '../services/authService.js';

/** Nom du cookie de session. */
export const SESSION_COOKIE = 'usm_session';
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** @typedef {import('../config/index.js').Role} Role */

/**
 * Lit un cookie de l'en-tête Cookie (sans dépendance).
 * @param {string | undefined} header
 * @param {string} name
 * @returns {string | undefined}
 */
export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * @param {import('express').Request} req
 * @returns {boolean} true si la requête vient de ce PC.
 */
export function isLocalRequest(req) {
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '');
}

/**
 * @param {object} options
 * @param {import('../services/authService.js').Auth} options.auth
 * @param {boolean} options.trustLocalhost
 * @param {boolean} options.publicRead
 * @returns {import('express').RequestHandler}
 */
export function createIdentify({ auth, trustLocalhost, publicRead }) {
  return (req, res, next) => {
    const isLocal = trustLocalhost && isLocalRequest(req);
    const sessionRole = isLocal
      ? null
      : auth.verifySession(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.locals.isLocal = isLocal;
    res.locals.signedIn = sessionRole !== null;
    res.locals.role = isLocal ? 'admin' : (sessionRole ?? (publicRead ? 'read' : null));
    next();
  };
}

/**
 * Exige au moins le rôle indiqué : 401 sans connexion, 403 si le niveau est insuffisant.
 * À placer devant chaque route de l'API (sauf santé et connexion).
 *
 * @param {Role} required
 * @returns {import('express').RequestHandler}
 */
export function requireRole(required) {
  return (_req, res, next) => {
    /** @type {Role | null} */
    const role = res.locals.role ?? null;
    if (role === null) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in required' } });
    } else if (!hasRole(role, required)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN_ROLE',
          message: `Requires ${required} access`,
          params: { required },
        },
      });
    } else {
      next();
    }
  };
}
