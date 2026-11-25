// @ts-check
/**
 * Préférences de l'application (fichier JSON, SETTINGS_FILE, par défaut ./settings.json),
 * modifiables depuis la fenêtre « Préférences » (niveau admin).
 *
 * Contenu : modèles de nommage des dossiers et fichiers (voir parsers/naming.js) et
 * sauvegardes facultatives (copie de l'original avant une conversion vidéo ou l'écriture du
 * ReplayGain dans un MP3). Les fichiers chanson (.txt) et les playlists sont toujours
 * sauvegardés : ce n'est pas réglable.
 * Un fichier absent ou illisible donne les valeurs par défaut (et un message dans le journal).
 *
 * @module services/settingsService
 */
import { readFile } from 'node:fs/promises';
import { DEFAULT_NAMING, NAMING_KINDS, patternError } from '../parsers/naming.js';
import { writeFileAtomic } from './fileWriter.js';
import { SongEditError } from './songEditService.js';

/**
 * @typedef {object} BackupSettings  Sauvegarde de l'original avant écriture (true = oui).
 * @property {boolean} videoConversion  Vidéo d'origine avant sa conversion en MP4 H.264.
 * @property {boolean} replayGain       MP3 avant l'écriture du ReplayGain dans son tag.
 *
 * @typedef {object} Settings
 * @property {import('../parsers/naming.js').NamingRules} naming
 * @property {BackupSettings} backups
 */

/** Sauvegardes facultatives, dans l'ordre d'affichage. */
export const BACKUP_KINDS = Object.freeze(/** @type {const} */ (['videoConversion', 'replayGain']));

/** @returns {Settings} Valeurs par défaut (copie modifiable). */
export function defaultSettings() {
  return {
    naming: structuredClone(
      /** @type {import('../parsers/naming.js').NamingRules} */ (DEFAULT_NAMING),
    ),
    backups: { videoConversion: true, replayGain: true },
  };
}

/**
 * Vérifie des préférences reçues du navigateur.
 * @param {unknown} input
 * @returns {Settings}
 * @throws {SongEditError}  INVALID_SETTINGS, avec l'élément et la raison (code traduisible).
 */
export function validateSettings(input) {
  const naming = /** @type {any} */ (input)?.naming;
  if (naming === null || typeof naming !== 'object') {
    throw new SongEditError('INVALID_REQUEST', 'Expected { naming: { … } }', 400);
  }
  const result = defaultSettings();
  for (const kind of NAMING_KINDS) {
    const rule = naming[kind];
    if (rule === undefined) continue; // élément non envoyé : valeur par défaut
    if (rule === null || typeof rule !== 'object' || typeof rule.enabled !== 'boolean') {
      throw new SongEditError('INVALID_REQUEST', `Invalid rule for ${kind}`, 400);
    }
    const reason = patternError(rule.pattern);
    if (reason) {
      throw new SongEditError('INVALID_SETTINGS', `Invalid pattern for ${kind}: ${reason}`, 400, {
        kind,
        reason,
      });
    }
    result.naming[kind] = { enabled: rule.enabled, pattern: rule.pattern.trim() };
  }
  // Sauvegardes : absentes (ancien fichier) = valeurs par défaut (tout est sauvegardé).
  const backups = /** @type {any} */ (input)?.backups;
  if (backups !== undefined) {
    if (backups === null || typeof backups !== 'object') {
      throw new SongEditError('INVALID_REQUEST', 'Invalid backups', 400);
    }
    for (const kind of BACKUP_KINDS) {
      if (backups[kind] === undefined) continue;
      if (typeof backups[kind] !== 'boolean') {
        throw new SongEditError('INVALID_REQUEST', `Invalid backups.${kind}`, 400);
      }
      result.backups[kind] = backups[kind];
    }
  }
  return result;
}

/**
 * @param {object} options
 * @param {string} options.file  Chemin du fichier JSON.
 * @param {Pick<Console, 'warn' | 'info'>} [options.logger]
 */
export function createSettings({ file, logger = console }) {
  /** @type {Settings} */
  let current = defaultSettings();

  return {
    /** @returns {Settings} Préférences en cours (valeurs par défaut avant load()). */
    get() {
      return current;
    },

    /**
     * Lit le fichier (absent : valeurs par défaut ; invalide : idem, avec un message).
     * @returns {Promise<Settings>}
     */
    async load() {
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        current = defaultSettings();
        return current;
      }
      try {
        current = validateSettings(JSON.parse(text));
      } catch (error) {
        logger.warn(`Settings file ignored (${file}): ${/** @type {Error} */ (error).message}`);
        current = defaultSettings();
      }
      return current;
    },

    /**
     * Vérifie puis enregistre (écriture atomique).
     * @param {unknown} input
     * @returns {Promise<Settings>}
     * @throws {SongEditError}
     */
    async save(input) {
      const next = validateSettings(input);
      await writeFileAtomic(file, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
      current = next;
      logger.info(`Settings saved to ${file}`);
      return current;
    },
  };
}

/** @typedef {ReturnType<typeof createSettings>} SettingsStore */
