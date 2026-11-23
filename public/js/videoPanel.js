// @ts-check
/**
 * Fenêtre vidéo au-dessus de la barre de lecture : la vidéo de la chanson est jouée
 * **sans le son** et suit la musique de la preview (lecture, pause, déplacements),
 * décalée de #VIDEOGAP comme dans UltraStar Deluxe.
 *
 * Les formats que le navigateur ne sait pas lire (.avi, MPEG-4 ancien…) sont ignorés :
 * la fenêtre ne s'affiche pas pour ces chansons.
 *
 * @module videoPanel
 */
import { videoUrl } from './api.js';
import { needsVideoResync, videoMimeType, videoTimeFor } from './previewCore.js';

const ENABLED_KEY = 'usm.video';

/** @typedef {import('./previewPlayer.js').PlayerState} PlayerState */
/** @typedef {import('./api.js').Song} Song */

/** @returns {boolean} */
function readEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * @param {HTMLElement} root  Conteneur de la fenêtre (contient un <video>).
 */
export function createVideoPanel(root) {
  const video = /** @type {HTMLVideoElement} */ (root.querySelector('video'));
  video.muted = true; // le son vient de la preview audio, jamais de la vidéo
  video.playsInline = true;

  let enabled = readEnabled();
  /** @type {string | null} */
  let loadedSongId = null;
  /**
   * Vidéos (URL) qui n'ont pas pu être lues (format non pris en charge). Par URL et non par
   * chanson : une vidéo convertie a une nouvelle URL, elle est donc retentée.
   */
  const unplayable = new Set();
  /** URL de la vidéo chargée. @type {string | null} */
  let loadedUrl = null;
  /** @type {PlayerState | null} */
  let last = null;

  /**
   * La chanson a-t-elle une vidéo que ce navigateur peut lire ?
   * @param {Song | null} song
   * @returns {boolean}
   */
  function hasPlayableVideo(song) {
    if (!song?.files.video || unplayable.has(videoUrl(song))) return false;
    const mime = videoMimeType(song.files.video);
    return mime !== null && video.canPlayType(mime) !== '';
  }

  function hide() {
    root.hidden = true;
    if (!video.paused) video.pause();
  }

  function unload() {
    hide();
    loadedSongId = null;
    loadedUrl = null;
    video.removeAttribute('src');
    video.load();
  }

  /** Cale la vidéo sur la position de la musique. */
  function align() {
    if (!last?.song || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const target = videoTimeFor(last.currentTime, last.song.videoGap);
    const outside = target < 0 || (Number.isFinite(video.duration) && target >= video.duration);
    if (outside) {
      // Avant le début (gap négatif) ou après la fin de la vidéo : image figée.
      if (!video.paused) video.pause();
      if (target < 0 && video.currentTime !== 0) video.currentTime = 0;
      return;
    }
    if (needsVideoResync(video.currentTime, target)) video.currentTime = target;
    const shouldPlay = last.status === 'playing';
    if (shouldPlay && video.paused) video.play().catch(() => {});
    if (!shouldPlay && !video.paused) video.pause();
  }

  video.addEventListener('loadedmetadata', align);
  video.addEventListener('error', () => {
    if (loadedUrl) unplayable.add(loadedUrl);
    unload();
  });

  return {
    /**
     * Suit l'état du lecteur (appelé à chaque changement).
     * @param {PlayerState} state
     */
    sync(state) {
      last = state;
      const { song, status } = state;
      if (!song || status === 'idle' || status === 'error') {
        unload();
        return;
      }
      if (!enabled || !hasPlayableVideo(song)) {
        hide();
        return;
      }
      if (loadedSongId !== song.id || loadedUrl !== videoUrl(song)) {
        loadedSongId = song.id;
        loadedUrl = videoUrl(song);
        video.src = loadedUrl;
        video.load();
      }
      root.hidden = false;
      align();
    },

    /**
     * La chanson en cours a-t-elle une vidéo lisible ? (pour afficher le bouton vidéo)
     * @param {Song | null} song
     */
    isAvailable: hasPlayableVideo,

    isEnabled: () => enabled,

    /** Affiche / masque la vidéo (choix mémorisé). */
    toggle() {
      this.setEnabled(!enabled);
    },

    /**
     * Active ou désactive les vidéos (choix mémorisé).
     * @param {boolean} value
     */
    setEnabled(value) {
      enabled = value;
      try {
        localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off');
      } catch {
        // choix non mémorisé
      }
      if (last) this.sync(last);
    },
  };
}
