// @ts-check
/**
 * Lit codec et résolution d'une vidéo sans programme externe : seuls les MP4 sont analysés
 * (quelques Ko lus : en-têtes des boîtes, puis la boîte « moov »).
 * Pour les autres formats, on ne connaît que le format (d'après l'extension).
 *
 * @module services/videoProbe
 */
import { open, stat } from 'node:fs/promises';
import { containerOf, parseMoov, readBoxHeader } from '../parsers/mp4Video.js';

/** Taille maximale lue pour la boîte moov (index du fichier, normalement < 1 Mo). */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/**
 * @typedef {import('../parsers/mp4Video.js').VideoInfo & { modifiedAt: number | null }} ProbedVideo
 *   `modifiedAt` : date de modification de la vidéo (change après une conversion, ce qui
 *   invalide le cache du navigateur).
 */

/**
 * @param {string} file  Chemin absolu de la vidéo.
 * @returns {Promise<ProbedVideo>}  Jamais d'exception.
 */
export async function probeVideoFile(file) {
  const [info, modifiedAt] = await Promise.all([
    probeHeader(file),
    stat(file).then(
      (s) => s.mtimeMs,
      () => null,
    ),
  ]);
  return { ...info, modifiedAt };
}

/**
 * @param {string} file
 * @returns {Promise<import('../parsers/mp4Video.js').VideoInfo>}  Un fichier illisible donne
 *   un codec et une résolution inconnus.
 */
async function probeHeader(file) {
  const container = containerOf(file);
  /** @type {import('../parsers/mp4Video.js').VideoInfo} */
  const unknown = { container, codec: null, width: null, height: null };
  if (container !== 'mp4') return unknown;

  let handle;
  try {
    handle = await open(file, 'r');
    const { size: fileSize } = await handle.stat();
    const header = new Uint8Array(16);
    let offset = 0;
    let first = true;
    // Parcourt les boîtes de premier niveau (ftyp, mdat, moov…) en ne lisant que leur en-tête.
    while (offset < fileSize) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      const box = readBoxHeader(header.subarray(0, bytesRead), 0);
      if (!box || (first && box.type !== 'ftyp')) return { ...unknown, container: 'unknown' };
      first = false;
      const size = box.size === 0 ? fileSize - offset : box.size;
      if (box.type === 'moov') {
        if (size > MAX_MOOV_BYTES) return unknown;
        const moov = new Uint8Array(size);
        await handle.read(moov, 0, size, offset);
        const info = parseMoov(moov);
        return info ? { container, ...info } : unknown;
      }
      offset += size;
    }
    return unknown;
  } catch {
    return unknown;
  } finally {
    await handle?.close();
  }
}
