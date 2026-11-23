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
 * @property {{ container: string, codec: string | null, width: number | null, height: number | null,
 *   modifiedAt: number | null } | null} video  Format et date de la vidéo (null sans vidéo).
 * @property {number} videoGap   #VIDEOGAP en secondes.
 * @property {SongWarning[]} warnings
 * @property {string[]} [playlists]  Noms des playlists qui la contiennent (ajouté par main.js).
 * @property {number} modifiedAt
 */

/** Erreur d'API portant un code traduisible. */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {Record<string, string | number>} [params]  Valeurs du message (traduction).
   */
  constructor(code, message, status, params = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.params = params;
  }
}

/**
 * En-tête attendu par le serveur sur les appels de l'interface (voir requestGuard.js) :
 * un autre site ne peut pas l'ajouter à ses requêtes.
 */
const CLIENT_HEADERS = Object.freeze({ 'X-USM-Request': '1' });

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function requestJson(path, init = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { ...CLIENT_HEADERS, ...init.headers },
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Network error', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { code = 'INTERNAL_ERROR', message = res.statusText, params } = body.error ?? {};
    throw new ApiError(code, message, res.status, params);
  }
  return body;
}

/** @param {string} path */
const getJson = (path) => requestJson(path);

/**
 * @param {string} path
 * @param {unknown} body
 */
const postJson = (path, body) =>
  requestJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** @typedef {'read' | 'write' | 'admin'} Role */

/**
 * @typedef {object} AuthState
 * @property {Role | null} role
 * @property {boolean} isLocal   Sur le PC du serveur (admin sans clé).
 * @property {boolean} signedIn  Connecté avec une clé.
 * @property {boolean} hasKeys   Des clés sont configurées (connexion possible).
 */

/** @returns {Promise<{ data: AuthState }>} */
export const getMe = () => getJson('/auth/me');

/**
 * @param {string} key
 * @returns {Promise<{ data: { role: Role } }>}
 */
export const login = (key) => postJson('/auth/login', { key });

export const logout = () => postJson('/auth/logout', {});

/** @returns {Promise<{ status: string, version: string | null }>} */
export const getHealth = () => getJson('/health');

/**
 * @returns {Promise<{ data: Song[], meta: { count: number, scannedAt: string } }>}
 */
export const getSongs = () => getJson('/songs');

/**
 * Valeurs de facettes illustrées par une image (langues, décennies, éditions).
 * @returns {Promise<{ data: Record<'language' | 'decade' | 'edition' | 'tag', string[]> }>}
 */
export const getFacetImages = () => getJson('/facet-images');

/**
 * @typedef {object} Playlist  Playlist .upl reliée au catalogue.
 * @property {string} name
 * @property {string} file
 * @property {number} modifiedAt  Date du fichier (contrôle avant écriture).
 * @property {string[]} songIds   Chansons trouvées, dans l'ordre de la playlist.
 * @property {{ artist: string, title: string }[]} missing  Lignes sans chanson correspondante.
 */

/** @returns {Promise<{ data: Playlist[], meta: { configured: boolean } }>} */
export const getPlaylists = () => getJson('/playlists');

/**
 * Ajoute une chanson à une playlist (niveau écriture).
 * @param {string} file  Nom du fichier .upl.
 * @param {{ songId: string, expectedModifiedAt: number }} body
 * @returns {Promise<{ data: { playlist: Playlist | null, changed: boolean, backup: string | null } }>}
 */
export const addSongToPlaylist = (file, body) =>
  postJson(`/playlists/${encodeURIComponent(file)}/songs`, body);

/**
 * Retire une chanson d'une playlist (niveau écriture).
 * @param {string} file
 * @param {{ songId: string, expectedModifiedAt: number }} body
 * @returns {Promise<{ data: { playlist: Playlist | null, changed: boolean, backup: string | null } }>}
 */
export const removeSongFromPlaylist = (file, body) =>
  requestJson(`/playlists/${encodeURIComponent(file)}/songs`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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
 * Détail complet d'une chanson (relu dans son .txt).
 * @typedef {object} SongDetails
 * @property {Record<string, string>} headers
 * @property {{ notes: number, lineBreaks: number, isDuet: boolean, hasEnd: boolean }} stats
 * @property {string} encoding
 * @property {{ bpm: number | null, gap: number | null, videoGap: number | null,
 *   previewStart: number | null, previewSource: string | null, medleyStart: number | null,
 *   medleyEnd: number | null, start: number | null, end: number | null }} timing
 * @property {{ p1: string | null, p2: string | null }} singers
 * @property {VideoDetails | null} video  null sans vidéo.
 */

/**
 * @typedef {object} VideoDetails
 * @property {string} container   « mp4 », « avi »…
 * @property {string | null} codec  « h264 », « hevc », « mpeg4 »…
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} duration
 * @property {number | null} frameRate
 * @property {boolean} recommended  Format MP4 H.264.
 * @property {boolean} oversized    Plus grande que 1080p.
 * @property {boolean} isAudio  Sert aussi de fichier audio (#MP3) : jamais convertie.
 * @property {boolean} canConvert   ffmpeg disponible et vidéo à convertir.
 * @property {boolean} canExtractAudio  ffmpeg disponible et vidéo qui sert aussi de musique.
 */

/**
 * @typedef {object} VideoJob  Conversion vidéo en cours ou terminée.
 * @property {string} songId
 * @property {'running' | 'done' | 'error'} state
 * @property {number | null} progress  0 à 1, null si inconnu.
 * @property {string} from
 * @property {string} to
 * @property {boolean} replaces
 * @property {string | null} code
 * @property {string | null} backup
 */

/**
 * @param {string} id
 * @returns {Promise<{ data: { song: Song, details: SongDetails } }>}
 */
export const getSongDetails = (id) => getJson(`/songs/${encodeURIComponent(id)}`);

/**
 * @typedef {object} HeaderChange
 * @property {string} header
 * @property {string | null} before
 * @property {string | null} after
 */

/**
 * Modifie des en-têtes d'une chanson (niveau écriture). Avec `dryRun`, rien n'est écrit :
 * le serveur renvoie seulement les changements qu'il ferait.
 *
 * @param {string} id
 * @param {{ values: Record<string, string | null>, expectedModifiedAt: number, dryRun?: boolean }} body
 * @returns {Promise<{ data: { changes: HeaderChange[], song: Song, backup: string | null } }>}
 */
export const updateSongHeaders = (id, body) =>
  requestJson(`/songs/${encodeURIComponent(id)}/headers`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * Convertit le fichier d'une chanson en UTF-8 sans BOM (niveau écriture).
 * @param {string} id
 * @param {{ expectedModifiedAt: number }} body
 * @returns {Promise<{ data: { changed: boolean, from: string, song: Song, backup: string | null } }>}
 */
export const convertSongToUtf8 = (id, body) =>
  postJson(`/songs/${encodeURIComponent(id)}/convert-utf8`, body);

/**
 * @typedef {object} BulkCandidate  Fichier concerné par une correction en masse (simulation).
 * @property {string} id
 * @property {string} artist
 * @property {string} title
 * @property {string} file        Chemin relatif « dossier/fichier.txt ».
 * @property {string} from        Encodage actuel.
 * @property {number} modifiedAt  Date de modification vue lors de la simulation.
 */

/**
 * @typedef {object} BulkResult
 * @property {string} id
 * @property {'converted' | 'unchanged' | 'error'} status
 * @property {string} [code]             Code d'erreur (ex. SONG_CHANGED).
 * @property {string | null} [backup]
 */

/**
 * Conversion en masse en UTF-8 sans BOM (niveau écriture).
 * - `{ dryRun: true }` : simulation, renvoie les fichiers concernés ;
 * - `{ items }` : convertit ces fichiers (au plus 200 par appel).
 *
 * @param {{ dryRun: true } | { items: { id: string, expectedModifiedAt: number }[] }} body
 * @returns {Promise<{ data: { items?: BulkCandidate[], results?: BulkResult[] } }>}
 */
export const bulkConvertToUtf8 = (body) => postJson('/bulk/convert-utf8', body);

/**
 * Conversion de la vidéo en MP4 H.264 (niveau écriture). Simulation avec `dryRun` ;
 * sinon la conversion est lancée en tâche de fond (suivre avec getVideoJob).
 * @param {string} id
 * @param {{ expectedModifiedAt: number, dryRun?: boolean }} body
 * @returns {Promise<{ data: { plan: { from: string, to: string, replaces: boolean }, job: VideoJob | null } }>}
 */
export const convertSongVideo = (id, body) =>
  postJson(`/songs/${encodeURIComponent(id)}/convert-video`, body);

/**
 * Crée le MP3 d'une chanson dont la vidéo sert aussi de musique, et met à jour #AUDIO / #MP3
 * (niveau écriture). Avec `dryRun`, rien n'est écrit.
 * @param {string} id
 * @param {{ expectedModifiedAt: number, dryRun?: boolean }} body
 * @returns {Promise<{ data: { plan: { from: string, to: string, reuse: boolean }, song: Song, headers: string[], backup: string | null } }>}
 */
export const extractSongAudio = (id, body) =>
  postJson(`/songs/${encodeURIComponent(id)}/extract-audio`, body);

/**
 * État de la dernière conversion vidéo d'une chanson (niveau écriture).
 * @param {string} id
 * @returns {Promise<{ data: { job: VideoJob | null } }>}
 */
export const getVideoJob = (id) => getJson(`/songs/${encodeURIComponent(id)}/convert-video`);

/**
 * @typedef {object} VideoCandidate  Vidéo à convertir (simulation en masse).
 * @property {string} id
 * @property {string | null} artist
 * @property {string | null} title
 * @property {string} file
 * @property {string} container
 * @property {string | null} codec
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} size  Octets.
 * @property {boolean} isAudio  Sert aussi de fichier audio (#MP3) : jamais convertie.
 * @property {boolean} oversized  Plus grande que 1080p.
 * @property {number} modifiedAt
 */

/**
 * @typedef {object} VideoBatch  Lot de conversions vidéo.
 * @property {'running' | 'done' | 'stopped'} state
 * @property {boolean} stopRequested
 * @property {{ id: string, artist: string | null, title: string | null,
 *   status: 'pending' | 'running' | 'converted' | 'error' | 'skipped',
 *   progress: number | null, code: string | null }[]} items
 */

/**
 * Conversion vidéo en masse (niveau écriture) : simulation avec `{ dryRun: true }`,
 * sinon lancement d'un lot (au plus 200) traité en tâche de fond.
 * @param {{ dryRun: true } | { items: { id: string, expectedModifiedAt: number }[] }} body
 * @returns {Promise<{ data: { available?: boolean, items?: VideoCandidate[], batch?: VideoBatch } }>}
 */
export const bulkConvertVideos = (body) => postJson('/bulk/convert-video', body);

/** @returns {Promise<{ data: { batch: VideoBatch | null } }>} Lot en cours ou dernier lot. */
export const getVideoBatch = () => getJson('/bulk/convert-video');

/** @returns {Promise<{ data: { batch: VideoBatch | null } }>} Arrêt après la vidéo en cours. */
export const stopVideoBatch = () => postJson('/bulk/convert-video/stop', {});

/**
 * @typedef {object} MbCandidate  Enregistrement trouvé sur MusicBrainz.
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {number | null} year
 * @property {string | null} album
 * @property {number} score
 * @property {string | null} artistId
 * @property {string | null} releaseGroupId
 */

/**
 * @typedef {object} MbSuggestion  Valeurs proposées par MusicBrainz.
 * @property {number | null} year
 * @property {{ code: string, name: string }[]} languages
 * @property {string[]} genres
 */

/**
 * Recherche MusicBrainz de la chanson (artiste + titre), niveau écriture.
 * @param {string} id
 * @returns {Promise<{ data: { candidates: MbCandidate[] } }>}
 */
export const searchMusicBrainz = (id) => getJson(`/songs/${encodeURIComponent(id)}/musicbrainz`);

/**
 * Valeurs proposées pour l'enregistrement choisi.
 * @param {string} id
 * @param {MbCandidate} candidate
 * @returns {Promise<{ data: { suggestion: MbSuggestion } }>}
 */
export function getMusicBrainzSuggestion(id, candidate) {
  const params = new URLSearchParams();
  if (candidate.artistId) params.set('artistId', candidate.artistId);
  if (candidate.releaseGroupId) params.set('releaseGroupId', candidate.releaseGroupId);
  const query = params.size > 0 ? `?${params}` : '';
  return getJson(
    `/songs/${encodeURIComponent(id)}/musicbrainz/${encodeURIComponent(candidate.id)}${query}`,
  );
}

/**
 * Relit tous les fichiers .txt de la bibliothèque (niveau écriture).
 * @returns {Promise<{ data: { count: number, durationMs: number, skipped: number, errors: number } }>}
 */
export const rescanCatalog = () => postJson('/catalog/rescan', {});

/**
 * URL du fichier vidéo d'une chanson.
 * @param {Song} song
 * @returns {string}
 */
export function videoUrl(song) {
  // Date de la vidéo elle-même : après une conversion sous le même nom, l'URL change.
  const version = song.video?.modifiedAt ?? song.modifiedAt;
  return `/api/songs/${encodeURIComponent(song.id)}/video?v=${Math.trunc(version)}`;
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
