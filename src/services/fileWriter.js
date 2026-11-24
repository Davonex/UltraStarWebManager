// @ts-check
/**
 * Écriture sûre des fichiers de la bibliothèque :
 * - sauvegarde datée de l'original dans le dossier de sauvegardes (historique conservé) ;
 * - écriture atomique : fichier temporaire dans le même dossier, puis renommage. Si quelque
 *   chose échoue en cours de route, l'original reste intact.
 *
 * @module services/fileWriter
 */
import { randomUUID } from 'node:crypto';
import { constants, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from '../utils/safePath.js';

/**
 * Horodatage utilisable dans un nom de fichier Windows (« 2026-11-21T10-30-00-123Z »).
 * @param {Date} date
 * @returns {string}
 */
export function fileTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Copie un fichier dans le dossier de sauvegardes, en reproduisant son chemin relatif :
 * `backups/<dossier>/<nom>.<horodatage><extension>`.
 *
 * @param {object} options
 * @param {string} options.file          Fichier à sauvegarder (chemin absolu).
 * @param {string} options.relativePath  Chemin relatif dans la bibliothèque.
 * @param {string} options.backupDir
 * @param {Date} [options.date]
 * @returns {Promise<string>} Chemin de la sauvegarde, relatif au dossier de sauvegardes.
 */
export async function backupFile({ file, relativePath, backupDir, date = new Date() }) {
  const { dir, name, ext } = path.parse(relativePath);
  const relativeBackup = path.join(dir, `${name}.${fileTimestamp(date)}${ext}`);
  const target = resolveInside(backupDir, relativeBackup);
  if (!target) throw new Error(`Backup path outside of the backup folder: ${relativeBackup}`);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(file, target, constants.COPYFILE_EXCL); // n'écrase jamais une sauvegarde
  return relativeBackup.split(path.sep).join('/');
}

/** Erreurs d'un fichier verrouillé par un autre programme (Windows surtout). */
export const LOCKED_FILE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Nouvelles tentatives quand le fichier est verrouillé (antivirus, synchronisation…). */
const RENAME_ATTEMPTS = 5;
const RENAME_DELAY_MS = 200;

/**
 * Remplace le contenu d'un fichier de façon atomique.
 *
 * Sous Windows, un antivirus, l'indexation ou un outil de synchronisation (Synology Drive,
 * OneDrive…) peut verrouiller le fichier quelques instants : le remplacement est alors
 * retenté plusieurs fois avant d'abandonner (le fichier d'origine reste intact).
 *
 * @param {string} file
 * @param {Uint8Array} data
 * @param {{ attempts?: number, delayMs?: number }} [retry]
 */
export async function writeFileAtomic(file, data, retry = {}) {
  const { attempts = RENAME_ATTEMPTS, delayMs = RENAME_DELAY_MS } = retry;
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`,
  );
  await writeFile(temporary, data, { flag: 'wx' });
  try {
    await replaceFile(temporary, file, { attempts, delayMs });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Renomme un fichier ou un dossier, en réessayant quelques fois s'il est verrouillé
 * (antivirus, synchronisation, lecture en cours…).
 *
 * @param {string} from
 * @param {string} to
 * @param {RenameOptions} [retry]
 */
export async function renameWithRetry(from, to, retry = {}) {
  const { attempts = RENAME_ATTEMPTS, delayMs = RENAME_DELAY_MS, renameFn = rename } = retry;
  for (let attempt = 1; ; attempt++) {
    try {
      await renameFn(from, to);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? '';
      if (!LOCKED_FILE_CODES.has(code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/**
 * @typedef {object} RenameOptions
 * @property {number} [attempts]
 * @property {number} [delayMs]
 * @property {(from: string, to: string) => Promise<void>} [renameFn]  Pour les tests.
 */

/**
 * Remplace `target` par `source` (même dossier).
 *
 * Sous Windows, remplacer un fichier **ouvert** échoue (EPERM), même quand le programme qui
 * le lit autorise sa suppression : c'est le cas de ce serveur pendant qu'il envoie la vidéo ou
 * la musique au navigateur, ou d'un lecteur. On écarte alors d'abord l'ancien fichier sous un
 * nom caché (un fichier ouvert peut être renommé), puis on met le nouveau à sa place ; l'ancien
 * est supprimé (effacé pour de bon quand le dernier lecteur le ferme). Un programme qui
 * verrouille complètement le fichier (sans autoriser sa suppression) fait toujours échouer
 * l'opération : le fichier d'origine reste alors intact.
 *
 * @param {string} source
 * @param {string} target
 * @param {RenameOptions} [options]
 */
export async function replaceFile(source, target, options = {}) {
  const renameFn = options.renameFn ?? rename;
  try {
    await renameWithRetry(source, target, options);
    return;
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? '';
    if (!LOCKED_FILE_CODES.has(code)) throw error;
    const aside = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${randomUUID().slice(0, 8)}.usm-old`,
    );
    try {
      await renameFn(target, aside);
    } catch {
      throw error; // verrou complet (ou source verrouillée) : erreur d'origine
    }
    try {
      await renameFn(source, target);
    } catch (second) {
      await renameFn(aside, target).catch(() => {}); // l'original reprend sa place
      throw second;
    }
    await rm(aside, { force: true }).catch(() => {});
  }
}
