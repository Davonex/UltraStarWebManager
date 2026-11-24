// @ts-check
/**
 * Aperçu d'un modèle de nommage dans les préférences (sans DOM, testé dans test/public/).
 * Même règle que le serveur (src/parsers/naming.js, expectedName) : « / » et « \ » deviennent
 * un tiret, les autres caractères interdits par Windows sont retirés.
 * @module namingPreview
 */

/** Chanson d'exemple des aperçus. */
export const PREVIEW_SONG = Object.freeze({ artist: 'AC/DC', title: 'Back In Black' });

/** Extension montrée dans l'aperçu de chaque élément. */
export const PREVIEW_EXTENSIONS = Object.freeze({
  folder: '',
  txt: '.txt',
  duet: '.txt',
  audio: '.mp3',
  video: '.mp4',
  cover: '.jpg',
  background: '.jpg',
  vocals: '.mp3',
  instrumental: '.mp3',
});

/**
 * Nom produit par un modèle pour une chanson.
 * @param {string} pattern  Ex. « {artist} - {title} [CO] ».
 * @param {string} artist
 * @param {string} title
 * @returns {string}
 */
export function previewName(pattern, artist, title) {
  return pattern
    .replace(/\{(artist|title)\}/g, (_, name) => (name === 'artist' ? artist : title))
    .replace(/[\\/]/g, '-')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Le modèle contient-il au moins {artist} ou {title} ? (contrôle rapide ; le serveur valide)
 * @param {string} pattern
 */
export function hasPlaceholder(pattern) {
  return /\{(artist|title)\}/.test(pattern);
}
