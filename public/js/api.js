// @ts-check
/**
 * Accès à l'API du serveur. Tous les appels fetch passent par ici.
 * Le serveur renvoie des codes d'erreur stables (ex. « ROUTE_NOT_FOUND ») que
 * l'interface traduit via la clé `errors.<CODE>`.
 * @module api
 */

/**
 * @typedef {object} SongWarning
 * @property {string} code
 * @property {string} message  Texte anglais (repli si la traduction manque).
 * @property {Record<string, string | number>} [params]
 */

/**
 * Chanson telle que renvoyée par GET /api/songs (même structure que Song côté serveur).
 * @typedef {object} Song
 * @property {string} id
 * @property {string} folder
 * @property {string} txtFile
 * @property {string | null} title
 * @property {string | null} artist
 * @property {number | null} year
 * @property {number | null} decade
 * @property {string[]} genres
 * @property {string[]} languages
 * @property {string[]} editions
 * @property {string[]} creators
 * @property {string[]} tags
 * @property {boolean} isDuet
 * @property {number | null} previewStart  Début de preview (s), null = automatique.
 * @property {'tag' | 'medley' | null} previewSource
 * @property {{ audio: string | null, cover: string | null, background: string | null, video: string | null }} files
 * @property {SongWarning[]} warnings
 * @property {number} modifiedAt
 */

/** Erreur d'API portant un code traduisible. */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function getJson(path) {
  let res;
  try {
    res = await fetch(`/api${path}`);
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Network error', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { code = 'INTERNAL_ERROR', message = res.statusText } = body.error ?? {};
    throw new ApiError(code, message, res.status);
  }
  return body;
}

/** @returns {Promise<{ status: string, version: string | null }>} */
export const getHealth = () => getJson('/health');

/**
 * @returns {Promise<{ data: Song[], meta: { count: number, scannedAt: string } }>}
 */
export const getSongs = () => getJson('/songs');

/**
 * Valeurs de facettes illustrées par une image (langues, décennies, éditions).
 * @returns {Promise<{ data: Record<'language' | 'decade' | 'edition', string[]> }>}
 */
export const getFacetImages = () => getJson('/facet-images');

/**
 * URL de l'image d'une valeur de facette.
 * @param {string} facet
 * @param {string} value
 * @returns {string}
 */
export function facetImageUrl(facet, value) {
  return `/api/facet-images/${encodeURIComponent(facet)}/${encodeURIComponent(value)}`;
}

/**
 * URL du fichier audio d'une chanson.
 * @param {Song} song
 * @returns {string}
 */
export function audioUrl(song) {
  return `/api/songs/${encodeURIComponent(song.id)}/audio?v=${Math.trunc(song.modifiedAt)}`;
}

/**
 * URL de la pochette d'une chanson, ou null si elle n'en a pas.
 * La date de modification dans l'URL force le rechargement si le fichier change.
 * @param {Song} song
 * @returns {string | null}
 */
export function coverUrl(song) {
  if (!song.files.cover) return null;
  return `/api/songs/${encodeURIComponent(song.id)}/cover?v=${Math.trunc(song.modifiedAt)}`;
}
