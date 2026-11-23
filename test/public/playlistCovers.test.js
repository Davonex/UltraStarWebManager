// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MOSAIC_SIZE, pickMosaicSongs } from '../../public/js/playlistCovers.js';

/**
 * @param {string} id
 * @param {string | null} cover
 * @param {string} [folder]
 * @returns {import('../../public/js/api.js').Song}
 */
const song = (id, cover, folder = id) =>
  /** @type {any} */ ({ id, folder, files: { cover, audio: null, background: null, video: null } });

const SONGS = new Map(
  [
    song('a', 'a.jpg'),
    song('b', null),
    song('c', 'c.jpg'),
    song('c2', 'c.jpg', 'c'),
    song('d', 'd.jpg'),
    song('e', 'e.jpg'),
    song('f', 'f.jpg'),
  ].map((s) => [s.id, s]),
);

describe('pickMosaicSongs — pochettes de la mosaïque', () => {
  it('prend les premières chansons avec pochette, dans l’ordre de la playlist', () => {
    const picked = pickMosaicSongs(['a', 'b', 'c', 'x', 'd', 'e', 'f'], SONGS);
    assert.equal(MOSAIC_SIZE, 4);
    assert.deepEqual(
      picked.map((s) => s.id),
      ['a', 'c', 'd', 'e'],
    );
  });

  it('une seule pochette par dossier (versions d’une même chanson)', () => {
    assert.deepEqual(
      pickMosaicSongs(['c', 'c2', 'f'], SONGS).map((s) => s.id),
      ['c', 'f'],
    );
  });

  it('playlist vide ou sans pochette : aucune chanson', () => {
    assert.deepEqual(pickMosaicSongs([], SONGS), []);
    assert.deepEqual(pickMosaicSongs(['b', 'x'], SONGS), []);
  });
});
