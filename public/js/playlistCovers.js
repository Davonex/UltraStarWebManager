// @ts-check
/**
 * Vignette « mosaïque » d'une playlist : pochettes de ses premières chansons, choisies sans
 * DOM (fonction pure, testable).
 * @module playlistCovers
 */

/** Nombre de pochettes d'une mosaïque (2 × 2). */
export const MOSAIC_SIZE = 4;

/** @typedef {import('./api.js').Song} Song */

/**
 * Chansons dont la pochette illustre la playlist : les premières de la playlist qui ont une
 * pochette, une seule par dossier (deux versions d'une chanson partagent la même image).
 *
 * @param {readonly string[]} songIds  Chansons de la playlist, dans son ordre.
 * @param {ReadonlyMap<string, Song>} songsById
 * @param {number} [limit]
 * @returns {Song[]}
 */
export function pickMosaicSongs(songIds, songsById, limit = MOSAIC_SIZE) {
  /** @type {Song[]} */
  const picked = [];
  /** @type {Set<string>} */
  const folders = new Set();
  for (const id of songIds) {
    if (picked.length >= limit) break;
    const song = songsById.get(id);
    if (!song?.files.cover || folders.has(song.folder)) continue;
    folders.add(song.folder);
    picked.push(song);
  }
  return picked;
}
