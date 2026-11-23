// @ts-check
/**
 * Authentification par clé d'accès et sessions signées.
 *
 * - Trois niveaux : lecture < écriture < admin. Chaque niveau inclut les précédents.
 * - Une clé valide donne un jeton de session `rôle.expiration.signature`, signé (HMAC-SHA256)
 *   avec un secret dérivé des clés : changer une clé dans .env déconnecte tout le monde, et
 *   un redémarrage du serveur ne déconnecte personne.
 * - Le jeton voyage dans un cookie HttpOnly (illisible par le JavaScript).
 * - Anti force brute : trop d'échecs depuis une même adresse la bloquent temporairement.
 *
 * @module services/authService
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** @typedef {import('../config/index.js').Role} Role */

/** Niveaux d'accès, du plus faible au plus fort. */
/** @type {readonly Role[]} */
export const ROLES = Object.freeze(['read', 'write', 'admin']);

/** Échecs de connexion autorisés par adresse et par fenêtre de temps. */
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Indique si un rôle donne au moins le niveau demandé.
 * @param {Role | null} actual
 * @param {Role} required
 * @returns {boolean}
 */
export function hasRole(actual, required) {
  return actual !== null && ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();

/**
 * Comparaison à temps constant (ne révèle pas, par sa durée, combien de caractères sont bons).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * @param {object} options
 * @param {Readonly<Record<Role, string | null>>} options.accessKeys
 * @param {number} options.sessionDays
 * @param {() => number} [options.now]  Horloge (remplaçable dans les tests).
 */
export function createAuth({ accessKeys, sessionDays, now = Date.now }) {
  const secret = createHash('sha256')
    .update(`usm-session|${JSON.stringify(accessKeys)}`)
    .digest();
  /** @type {Map<string, { count: number, since: number }>} */
  const failures = new Map();

  /** @param {string} payload */
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');

  return {
    /** Indique si au moins une clé est configurée. */
    hasKeys() {
      return ROLES.some((role) => accessKeys[role] !== null);
    },

    /**
     * Rôle correspondant à une clé (le plus élevé), ou null.
     * @param {string} key
     * @returns {Role | null}
     */
    roleForKey(key) {
      let found = /** @type {Role | null} */ (null);
      // On compare toutes les clés (pas d'arrêt anticipé) pour un temps de réponse constant.
      for (const role of ROLES) {
        const expected = accessKeys[role];
        if (expected !== null && safeEqual(key, expected)) found = role;
      }
      return found;
    },

    /**
     * Crée un jeton de session.
     * @param {Role} role
     * @returns {{ token: string, maxAgeMs: number }}
     */
    createSession(role) {
      const maxAgeMs = sessionDays * DAY_MS;
      const payload = `${role}.${now() + maxAgeMs}`;
      return { token: `${payload}.${sign(payload)}`, maxAgeMs };
    },

    /**
     * Rôle d'un jeton valide (signature correcte, non expiré, clé toujours configurée).
     * @param {string | undefined} token
     * @returns {Role | null}
     */
    verifySession(token) {
      const parts = token?.split('.') ?? [];
      if (parts.length !== 3) return null;
      const [role, expires, signature] = parts;
      if (!safeEqual(signature, sign(`${role}.${expires}`))) return null;
      if (!ROLES.includes(/** @type {Role} */ (role))) return null;
      if (!(Number(expires) > now())) return null;
      return accessKeys[/** @type {Role} */ (role)] === null ? null : /** @type {Role} */ (role);
    },

    /**
     * Indique si une adresse est bloquée après trop d'échecs.
     * @param {string} address
     * @returns {boolean}
     */
    isBlocked(address) {
      const entry = failures.get(address);
      if (!entry) return false;
      if (now() - entry.since > ATTEMPT_WINDOW_MS) {
        failures.delete(address);
        return false;
      }
      return entry.count >= MAX_FAILED_ATTEMPTS;
    },

    /** @param {string} address */
    recordFailure(address) {
      const entry = failures.get(address);
      if (!entry || now() - entry.since > ATTEMPT_WINDOW_MS) {
        failures.set(address, { count: 1, since: now() });
      } else {
        entry.count++;
      }
    },

    /** @param {string} address */
    clearFailures(address) {
      failures.delete(address);
    },
  };
}

/** @typedef {ReturnType<typeof createAuth>} Auth */
