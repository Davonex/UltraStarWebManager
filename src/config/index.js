// @ts-check
/**
 * Configuration de l'application, lue depuis les variables d'environnement
 * (fichier .env chargé par `node --env-file-if-exists=.env`).
 * @module config
 */

/**
 * @typedef {object} AppConfig
 * @property {number} port
 * @property {string} host
 * @property {string | null} songDir
 * @property {string | null} playlistDir
 * @property {string | null} categoryCoversDir Dossier `covers` d'UltraStar (images des catégories).
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<AppConfig>}
 */
export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT invalide : ${env.PORT}`);
  }
  return Object.freeze({
    port,
    host: env.HOST ?? '127.0.0.1',
    songDir: env.SONG_DIR || null,
    playlistDir: env.PLAYLIST_DIR || null,
    categoryCoversDir: env.CATEGORY_COVERS_DIR || null,
  });
}
