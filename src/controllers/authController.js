// @ts-check
/**
 * Connexion / déconnexion par clé d'accès.
 * @module controllers/authController
 */
import { SESSION_COOKIE } from '../middlewares/auth.js';

/** Longueur maximale acceptée pour une clé (évite de hacher des corps énormes). */
const MAX_KEY_LENGTH = 256;

/**
 * @param {import('../services/authService.js').Auth} auth
 */
export function createAuthController(auth) {
  /**
   * Vérifie une clé et pose le cookie de session.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {unknown} key
   * @returns {{ ok: true, role: import('../config/index.js').Role } | { ok: false, status: number, code: string, message: string }}
   */
  function signIn(req, res, key) {
    const address = req.socket.remoteAddress ?? 'unknown';
    if (auth.isBlocked(address)) {
      return {
        ok: false,
        status: 429,
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many attempts, try later',
      };
    }
    const role =
      typeof key === 'string' && key.length <= MAX_KEY_LENGTH ? auth.roleForKey(key) : null;
    if (!role) {
      auth.recordFailure(address);
      return { ok: false, status: 401, code: 'INVALID_KEY', message: 'Invalid access key' };
    }
    auth.clearFailures(address);
    const { token, maxAgeMs } = auth.createSession(role);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: maxAgeMs,
    });
    return { ok: true, role };
  }

  return {
    /**
     * GET /api/auth/me — rôle courant.
     * Réponse : `{ data: { role, isLocal, signedIn, hasKeys } }` (signedIn = session ouverte).
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    me(_req, res) {
      res.json({
        data: {
          role: res.locals.role ?? null,
          isLocal: res.locals.isLocal === true,
          signedIn: res.locals.signedIn === true,
          hasKeys: auth.hasKeys(),
        },
      });
    },

    /**
     * POST /api/auth/login — `{ key }` → cookie de session.
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    login(req, res) {
      const result = signIn(req, res, req.body?.key);
      if (!result.ok) {
        res.status(result.status).json({ error: { code: result.code, message: result.message } });
        return;
      }
      res.json({ data: { role: result.role } });
    },

    /**
     * POST /api/auth/logout — supprime le cookie de session.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     */
    logout(_req, res) {
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
      res.json({ data: { role: null } });
    },

    /**
     * GET /login?key=… — lien de connexion à ouvrir une fois (ex. sur un téléphone) :
     * pose le cookie puis redirige vers l'accueil, ce qui retire la clé de la barre d'adresse.
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    loginLink(req, res) {
      const result = signIn(req, res, req.query.key);
      res.redirect(303, result.ok ? '/' : `/?login=${result.code}`);
    },
  };
}
