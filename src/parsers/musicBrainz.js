// @ts-check
/**
 * Réponses de l'API MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API), format JSON.
 * FONCTIONS PURES : construction des requêtes et lecture des réponses, sans accès réseau.
 *
 * - Recherche d'enregistrements (recording) par titre et artiste ;
 * - détail d'un enregistrement : année (first-release-date), langues des paroles
 *   (text-representation des disques, codes ISO 639-3) et genres (votes de la communauté).
 *
 * @module parsers/musicBrainz
 */

/** Codes de langue sans intérêt pour #LANGUAGE (sans paroles, plusieurs, indéterminée). */
const IGNORED_LANGUAGES = new Set(['zxx', 'mul', 'und', 'mis']);
/** Identifiant MusicBrainz (UUID). */
export const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Nombre maximal de genres proposés. */
const MAX_GENRES = 8;

/**
 * @typedef {object} MbCandidate  Enregistrement trouvé par la recherche.
 * @property {string} id           Identifiant MusicBrainz (MBID) de l'enregistrement.
 * @property {string} title
 * @property {string} artist       Artistes crédités (« A feat. B »).
 * @property {number | null} year  Année de la première sortie.
 * @property {string | null} album Premier disque officiel trouvé.
 * @property {number} score        Pertinence 0–100 selon MusicBrainz.
 * @property {string | null} artistId     Premier artiste (pour ses genres).
 * @property {string | null} releaseGroupId  Album (pour ses genres).
 */

/**
 * @typedef {object} MbSuggestion  Valeurs proposées pour une chanson.
 * @property {number | null} year
 * @property {{ code: string, name: string }[]} languages  Nom au format UltraStar (« French »).
 * @property {string[]} genres     Du plus voté au moins voté, sans doublon.
 */

/**
 * Échappe un texte pour une requête Lucene entre guillemets.
 * @param {string} text
 */
function quoted(text) {
  return `"${text.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * Requête de recherche d'un enregistrement (titre et artiste).
 * @param {string} artist
 * @param {string} title
 * @returns {string}
 */
export function buildRecordingQuery(artist, title) {
  return `recording:${quoted(title)} AND artist:${quoted(artist)}`;
}

/**
 * Année d'une date MusicBrainz (« 1995 », « 1995-03 », « 1995-03-20 »).
 * @param {unknown} date
 * @returns {number | null}
 */
export function yearOf(date) {
  const match = /^(\d{4})/.exec(typeof date === 'string' ? date : '');
  return match ? Number(match[1]) : null;
}

/**
 * Nom anglais d'une langue (format de #LANGUAGE) depuis son code ISO 639-3 (« fra » → « French »).
 * @param {string} code
 * @returns {string | null}  null si le code n'est pas une vraie langue.
 */
export function languageName(code) {
  const clean = code.toLowerCase();
  if (IGNORED_LANGUAGES.has(clean)) return null;
  try {
    const name = new Intl.DisplayNames('en', { type: 'language' }).of(clean);
    return name && name.toLowerCase() !== clean ? name : null;
  } catch {
    return null;
  }
}

/**
 * Genre MusicBrainz (en minuscules) → première lettre en majuscule (« pop rock » → « Pop rock »).
 * @param {string} genre
 */
export function genreLabel(genre) {
  const text = genre.trim();
  return text.charAt(0).toLocaleUpperCase('en') + text.slice(1);
}

/**
 * @param {any} credits  artist-credit MusicBrainz.
 * @returns {string}
 */
function creditText(credits) {
  if (!Array.isArray(credits)) return '';
  return credits
    .map((c) => `${c?.name ?? c?.artist?.name ?? ''}${c?.joinphrase ?? ''}`)
    .join('')
    .trim();
}

/**
 * Lit la réponse d'une recherche d'enregistrements.
 * @param {any} json
 * @returns {MbCandidate[]}  Par pertinence décroissante.
 */
export function parseRecordingSearch(json) {
  /** @type {any[]} */
  const recordings = Array.isArray(json?.recordings) ? json.recordings : [];
  return recordings
    .filter((r) => typeof r?.id === 'string' && MBID_PATTERN.test(r.id))
    .map((r) => {
      /** @type {any[]} */
      const releases = Array.isArray(r.releases) ? r.releases : [];
      const official = releases.find((rel) => rel?.status === 'Official') ?? releases[0];
      return {
        id: r.id,
        title: String(r.title ?? ''),
        artist: creditText(r['artist-credit']),
        year: yearOf(r['first-release-date']),
        album: official?.title ? String(official.title) : null,
        score: Number(r.score) || 0,
        artistId: r['artist-credit']?.[0]?.artist?.id ?? null,
        releaseGroupId: official?.['release-group']?.id ?? null,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Genres d'une entité (inc=genres), du plus voté au moins voté.
 * @param {any} entity
 * @returns {string[]}
 */
export function genresOf(entity) {
  /** @type {any[]} */
  const genres = Array.isArray(entity?.genres) ? entity.genres : [];
  return genres
    .filter((g) => typeof g?.name === 'string' && g.name.trim())
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .map((g) => genreLabel(g.name));
}

/**
 * Valeurs proposées à partir du détail d'un enregistrement (inc=releases+genres) et des
 * genres de son album et de son artiste (les enregistrements ont rarement des genres).
 *
 * @param {any} recording
 * @param {{ releaseGroup?: any, artist?: any }} [more]
 * @returns {MbSuggestion}
 */
export function buildSuggestion(recording, { releaseGroup, artist } = {}) {
  // Langue : la plus fréquente parmi les disques qui contiennent cet enregistrement.
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const release of Array.isArray(recording?.releases) ? recording.releases : []) {
    const code = release?.['text-representation']?.language;
    if (typeof code === 'string' && languageName(code))
      counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const languages = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => ({ code, name: /** @type {string} */ (languageName(code)) }));

  // Genres : enregistrement, puis album, puis artiste ; sans doublon (casse ignorée).
  /** @type {Map<string, string>} */
  const genres = new Map();
  for (const name of [...genresOf(recording), ...genresOf(releaseGroup), ...genresOf(artist)]) {
    if (!genres.has(name.toLowerCase())) genres.set(name.toLowerCase(), name);
  }

  return {
    year: yearOf(recording?.['first-release-date']),
    languages,
    genres: [...genres.values()].slice(0, MAX_GENRES),
  };
}
