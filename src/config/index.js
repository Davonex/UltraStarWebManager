// @ts-check
/**
 * Configuration de l'application, lue depuis les variables d'environnement
 * (fichier .env chargé par `node --env-file-if-exists=.env`).
 * @module config
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {'read' | 'write' | 'admin'} Role */

/** Racine du projet (pour les chemins par défaut). */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Version de l'application (package.json), affichée et envoyée à MusicBrainz. */
export const APP_VERSION = /** @type {string} */ (
  JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version
);

/** Longueur minimale d'une clé d'accès. */
export const MIN_KEY_LENGTH = 12;
/** Noms d'hôte qui désignent ce PC uniquement. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * @typedef {object} AppConfig
 * @property {number} port
 * @property {string} host
 * @property {string | null} songDir
 * @property {string | null} playlistDir
 * @property {string | null} categoryCoversDir Dossier `covers` d'UltraStar (images des catégories).
 * @property {string} backupDir  Sauvegardes datées des fichiers modifiés (défaut : ./backups).
 * @property {string} ffmpegPath  ffmpeg (« ffmpeg » si dans le PATH) ; ffprobe à côté.
 * @property {Readonly<Record<Role, string | null>>} accessKeys  Clé de chaque niveau d'accès.
 * @property {readonly string[]} allowedHosts  Noms d'hôte supplémentaires autorisés (en-tête Host).
 * @property {boolean} trustLocalhost  Requêtes venant de ce PC = admin sans clé.
 * @property {boolean} publicRead      READ_KEY vide : la lecture est ouverte à tous, sans clé.
 * @property {number} sessionDays      Durée d'une connexion.
 */

/**
 * @param {string} host
 * @returns {boolean} true si le serveur n'écoute que sur ce PC.
 */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host.replace(/^\[|\]$/g, '').toLowerCase());
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<AppConfig>}
 */
export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  const host = env.HOST || '127.0.0.1';

  /** @type {Record<Role, string | null>} */
  const accessKeys = {
    read: env.READ_KEY || null,
    write: env.WRITE_KEY || null,
    admin: env.ADMIN_KEY || null,
  };
  for (const [role, key] of Object.entries(accessKeys)) {
    if (key !== null && key.length < MIN_KEY_LENGTH) {
      throw new Error(`${role.toUpperCase()}_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    }
  }
  const definedKeys = Object.values(accessKeys).filter((key) => key !== null);
  if (new Set(definedKeys).size !== definedKeys.length) {
    throw new Error('READ_KEY, WRITE_KEY and ADMIN_KEY must all be different');
  }
  if (!isLoopbackHost(host) && definedKeys.length === 0) {
    throw new Error(
      `HOST=${host} opens the server to the network: set at least WRITE_KEY or ADMIN_KEY in .env`,
    );
  }

  const sessionDays = Number(env.SESSION_DAYS ?? 30);
  if (!(sessionDays > 0)) throw new Error(`Invalid SESSION_DAYS: ${env.SESSION_DAYS}`);

  return Object.freeze({
    port,
    host,
    songDir: env.SONG_DIR || null,
    playlistDir: env.PLAYLIST_DIR || null,
    categoryCoversDir: env.CATEGORY_COVERS_DIR || null,
    backupDir: path.resolve(PROJECT_ROOT, env.BACKUP_DIR || 'backups'),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    accessKeys: Object.freeze(accessKeys),
    allowedHosts: Object.freeze(
      (env.ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
    trustLocalhost: env.TRUST_LOCALHOST !== 'false',
    publicRead: accessKeys.read === null,
    sessionDays,
  });
}
