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

/**
 * Remplace le contenu d'un fichier de façon atomique.
 * @param {string} file
 * @param {Uint8Array} data
 */
export async function writeFileAtomic(file, data) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`,
  );
  await writeFile(temporary, data, { flag: 'wx' });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
