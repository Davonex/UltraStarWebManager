// @ts-check
/**
 * Lecture des playlists UltraStar Deluxe (.upl) : fonctions pures, sans accès disque.
 *
 * Format (une chanson par ligne, « Artiste : Titre ») :
 * ```
 * ######################################
 * #Ultrastar Deluxe Playlist Format v1.0
 * #Name: Top FR 80-90
 * #Songs:
 * Desireless : Voyage Voyage
 * ```
 * Les lignes commençant par « # » sont des en-têtes ou des commentaires.
 *
 * @module parsers/ultrastarPlaylist
 */

/** Séparateur entre l'artiste et le titre (le titre peut lui-même contenir « : »). */
const ENTRY_SEPARATOR = ' : ';
/** En-tête du nom affiché de la playlist. */
const NAME_HEADER = /^#\s*name\s*:(.*)$/i;

/**
 * @typedef {object} PlaylistEntry
 * @property {string} artist
 * @property {string} title
 */

/**
 * @typedef {object} ParsedPlaylist
 * @property {string | null} name   Valeur de « #Name: » (null si absente ou vide).
 * @property {PlaylistEntry[]} entries  Chansons, dans l'ordre du fichier.
 */

/**
 * Analyse le texte d'une playlist .upl.
 * Les lignes vides et les lignes sans séparateur « : » sont ignorées.
 *
 * @param {string} text
 * @returns {ParsedPlaylist}
 */
export function parseUltrastarPlaylist(text) {
  /** @type {string | null} */
  let name = null;
  /** @type {PlaylistEntry[]} */
  const entries = [];

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const match = NAME_HEADER.exec(line);
      if (match && match[1].trim() !== '') name ??= match[1].trim();
      continue;
    }
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return { name, entries };
}

/**
 * « Artiste : Titre » → { artist, title }, ou null si la ligne n'est pas une chanson.
 * @param {string} line
 * @returns {PlaylistEntry | null}
 */
function parseEntry(line) {
  const index = line.indexOf(ENTRY_SEPARATOR);
  if (index === -1) return null;
  const artist = line.slice(0, index).trim();
  const title = line.slice(index + ENTRY_SEPARATOR.length).trim();
  if (artist === '' || title === '') return null;
  return { artist, title };
}

/**
 * Ligne d'une chanson dans une playlist (« Artiste : Titre »).
 * @param {PlaylistEntry} entry
 * @returns {string}
 */
export function formatPlaylistEntry({ artist, title }) {
  return `${artist.trim()}${ENTRY_SEPARATOR}${title.trim()}`;
}

/**
 * Ajoute une chanson à la fin d'une playlist, sauf si elle y est déjà.
 * Les fins de ligne du fichier (CRLF ou LF) sont conservées.
 *
 * @param {string} text  Contenu décodé du .upl.
 * @param {PlaylistEntry} entry
 * @param {(a: PlaylistEntry, b: PlaylistEntry) => boolean} same  Comparaison de deux chansons.
 * @returns {{ text: string, changed: boolean }}
 */
export function addPlaylistEntry(text, entry, same) {
  const exists = text.split(/\r?\n/).some((line) => {
    const current = parseEntry(line.trim());
    return current !== null && same(current, entry);
  });
  if (exists) return { text, changed: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const base = text === '' || text.endsWith('\n') ? text : `${text}${eol}`;
  return { text: `${base}${formatPlaylistEntry(entry)}${eol}`, changed: true };
}

/**
 * Retire d'une playlist toutes les lignes d'une chanson (les autres lignes restent intactes).
 *
 * @param {string} text  Contenu décodé du .upl.
 * @param {PlaylistEntry} entry
 * @param {(a: PlaylistEntry, b: PlaylistEntry) => boolean} same  Comparaison de deux chansons.
 * @returns {{ text: string, removed: number }}
 */
export function removePlaylistEntry(text, entry, same) {
  // split en gardant les fins de ligne : chaque morceau = une ligne et son séparateur.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let removed = 0;
  const kept = lines.filter((line) => {
    const current = parseEntry(line.trim());
    if (current !== null && same(current, entry)) {
      removed += 1;
      return false;
    }
    return true;
  });
  return { text: kept.join(''), removed };
}
