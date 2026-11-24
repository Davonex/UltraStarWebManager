// @ts-check
/**
 * Client de l'API MusicBrainz (https://musicbrainz.org/ws/2/), avec `fetch` intégré à Node
 * (aucune dépendance).
 *
 * Règles de MusicBrainz respectées :
 * - User-Agent identifiant l'application et un contact ;
 * - au plus une requête par seconde (file d'attente) ;
 * - réponses gardées en mémoire (pas de requête répétée pour la même chanson).
 *
 * @module services/musicBrainzService
 */
import { APP_VERSION } from '../config/index.js';
import {
  buildRecordingQuery,
  buildSuggestion,
  MBID_PATTERN,
  parseRecordingSearch,
} from '../parsers/musicBrainz.js';

const API_ROOT = 'https://musicbrainz.org/ws/2/';
/** Intervalle minimal entre deux requêtes (ms) : la limite est d'une par seconde. */
export const MIN_INTERVAL_MS = 1100;
const TIMEOUT_MS = 15_000;
const CACHE_SIZE = 300;
const SEARCH_LIMIT = 8;

/** Erreur d'accès à MusicBrainz (réseau, limite de débit…). */
export class MusicBrainzError extends Error {
  /**
   * @param {'MUSICBRAINZ_UNAVAILABLE' | 'MUSICBRAINZ_BUSY' | 'MUSICBRAINZ_NOT_FOUND'} code
   * @param {string} message
   * @param {number} status  Statut HTTP à renvoyer au navigateur.
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'MusicBrainzError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]  Remplaçable dans les tests.
 * @param {string} [options.userAgent]
 * @param {number} [options.minIntervalMs]
 * @param {Pick<Console, 'warn'>} [options.logger]
 */
export function createMusicBrainz({
  fetch: fetchImpl = globalThis.fetch,
  userAgent = `UltraStarWebManager/${APP_VERSION} ( https://github.com/Davonex/UltraStarWebManager )`,
  minIntervalMs = MIN_INTERVAL_MS,
  logger = console,
} = {}) {
  /** @type {Map<string, unknown>} */
  const cache = new Map();
  /** Requêtes en cours (deux demandes identiques simultanées → une seule requête). */
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();
  /** File d'attente : chaque requête attend la fin de la précédente + l'intervalle. */
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  /**
   * GET JSON sur l'API (file d'attente, cache).
   * @param {string} path  Chemin relatif à /ws/2/, avec ses paramètres.
   * @returns {Promise<any>}
   */
  function get(path) {
    const url = new URL(path, API_ROOT);
    url.searchParams.set('fmt', 'json');
    const key = url.toString();
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const pending = inflight.get(key);
    if (pending) return pending;

    const result = queue.then(async () => {
      const wait = lastRequestAt + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      let response;
      try {
        response = await fetchImpl(key, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        logger.warn(`MusicBrainz unreachable: ${/** @type {Error} */ (error).message}`);
        throw new MusicBrainzError('MUSICBRAINZ_UNAVAILABLE', 'MusicBrainz is unreachable', 502);
      }
      if (response.status === 404) {
        throw new MusicBrainzError('MUSICBRAINZ_NOT_FOUND', 'Not found on MusicBrainz', 404);
      }
      if (response.status === 503 || response.status === 429) {
        throw new MusicBrainzError('MUSICBRAINZ_BUSY', 'MusicBrainz is busy, try again', 503);
      }
      if (!response.ok) {
        logger.warn(`MusicBrainz HTTP ${response.status} for ${key}`);
        throw new MusicBrainzError('MUSICBRAINZ_UNAVAILABLE', `HTTP ${response.status}`, 502);
      }
      const json = await response.json();
      if (cache.size >= CACHE_SIZE) cache.delete(/** @type {string} */ (cache.keys().next().value));
      cache.set(key, json);
      return json;
    });
    inflight.set(key, result);
    result.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
    // La file continue même si cette requête échoue.
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return {
    /**
     * Enregistrements correspondant à un artiste et un titre.
     * @param {string} artist
     * @param {string} title
     * @returns {Promise<import('../parsers/musicBrainz.js').MbCandidate[]>}
     */
    async search(artist, title) {
      const query = encodeURIComponent(buildRecordingQuery(artist, title));
      return parseRecordingSearch(await get(`recording?query=${query}&limit=${SEARCH_LIMIT}`));
    },

    /**
     * Valeurs proposées (année, langues, genres) pour un enregistrement choisi.
     * @param {string} recordingId
     * @param {{ artistId?: string | null, releaseGroupId?: string | null }} [related]
     *   Artiste et album de la recherche, pour compléter les genres.
     * @returns {Promise<import('../parsers/musicBrainz.js').MbSuggestion>}
     */
    async suggest(recordingId, { artistId = null, releaseGroupId = null } = {}) {
      const recording = await get(`recording/${recordingId}?inc=releases+genres+artist-credits`);
      const artist = artistId ?? recording?.['artist-credit']?.[0]?.artist?.id ?? null;
      // Compléments facultatifs : une erreur ici ne bloque pas la proposition.
      const optional = (/** @type {string | null} */ id, /** @type {string} */ kind) =>
        id && MBID_PATTERN.test(id) ? get(`${kind}/${id}?inc=genres`).catch(() => null) : null;
      const releaseGroup = await optional(releaseGroupId, 'release-group');
      const artistData = await optional(artist, 'artist');
      return buildSuggestion(recording, { releaseGroup, artist: artistData });
    },
  };
}

/** @typedef {ReturnType<typeof createMusicBrainz>} MusicBrainz */
