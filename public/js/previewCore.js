// @ts-check
/**
 * Calculs de la preview audio : fonctions pures, testables sans navigateur.
 * @module previewCore
 */

/** Durée d'une preview, en secondes. */
export const PREVIEW_LENGTH_S = 30;
/** Durée du fondu de fin, en secondes. */
export const FADE_OUT_S = 2;
/** Sans début connu, la preview démarre à cette fraction de la chanson. */
export const FALLBACK_START_RATIO = 0.3;
/** Marge minimale avant la fin du fichier pour démarrer une preview. */
const END_MARGIN_S = 5;

/**
 * Fenêtre de lecture de la preview.
 *
 * @param {number | null} previewStart  Début souhaité (s), null = automatique.
 * @param {number} duration             Durée de l'audio (s) ; NaN/Infinity si inconnue.
 * @returns {{ start: number, end: number }}
 */
export function previewWindow(previewStart, duration) {
  const known = Number.isFinite(duration) && duration > 0;
  const wanted = previewStart ?? (known ? duration * FALLBACK_START_RATIO : 0);
  const latest = known ? Math.max(0, duration - END_MARGIN_S) : wanted;
  const start = Math.min(Math.max(0, wanted), latest);
  const end = known ? Math.min(duration, start + PREVIEW_LENGTH_S) : start + PREVIEW_LENGTH_S;
  return { start, end };
}

/**
 * Coefficient de volume (0 à 1) pour le fondu de fin.
 * @param {number} currentTime
 * @param {number} end
 * @returns {number}
 */
export function fadeFactor(currentTime, end) {
  const remaining = end - currentTime;
  if (remaining >= FADE_OUT_S) return 1;
  return Math.max(0, remaining / FADE_OUT_S);
}

/**
 * Fraction (0 à 1) d'une position dans la chanson entière ; 0 si la durée est inconnue.
 * @param {number} seconds
 * @param {number} duration
 * @returns {number}
 */
export function songFraction(seconds, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, Math.max(0, seconds / duration));
}

/**
 * Formate une durée en « m:ss » (ou « h:mm:ss » au-delà d'une heure).
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Nouvel extrait après un déplacement dans la chanson : 30 s à partir de la position choisie.
 * @param {number} target    Position demandée (s).
 * @param {number} duration  Durée de la chanson (s).
 * @returns {{ start: number, end: number }}
 */
export function seekWindow(target, duration) {
  const start = Math.min(Math.max(0, target), Math.max(0, duration - 0.5));
  return { start, end: Math.min(duration, start + PREVIEW_LENGTH_S) };
}

/**
 * Position (s) correspondant à un point de la barre.
 * @param {number} clientX         Abscisse du pointeur.
 * @param {{ left: number, width: number }} rect  Rectangle de la barre.
 * @param {number} duration
 * @returns {number}
 */
export function positionFromPointer(clientX, rect, duration) {
  if (!(rect.width > 0) || !Number.isFinite(duration)) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
}

/** Écart toléré entre la vidéo et la musique avant de recaler la vidéo (s). */
export const VIDEO_SYNC_TOLERANCE_S = 0.3;

/** Formats vidéo lisibles par les navigateurs (les .avi, .mkv, .mpg, .flv ne le sont pas). */
const VIDEO_MIME_TYPES = Object.freeze({
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
});

/**
 * Type MIME d'un fichier vidéo lisible par un navigateur, ou null.
 * @param {string | null} fileName
 * @returns {string | null}
 */
export function videoMimeType(fileName) {
  const extension = fileName?.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_MIME_TYPES[/** @type {keyof typeof VIDEO_MIME_TYPES} */ (extension)] ?? null;
}

/**
 * Position dans la vidéo pour une position dans la musique, comme UltraStar Deluxe :
 * vidéo = musique + #VIDEOGAP (un gap négatif retarde le début de la vidéo).
 * @param {number} audioTime
 * @param {number} videoGap
 * @returns {number}
 */
export function videoTimeFor(audioTime, videoGap) {
  return audioTime + videoGap;
}

/**
 * Indique s'il faut recaler la vidéo sur la musique.
 * @param {number} videoTime
 * @param {number} target
 * @returns {boolean}
 */
export function needsVideoResync(videoTime, target) {
  return Math.abs(videoTime - target) > VIDEO_SYNC_TOLERANCE_S;
}
