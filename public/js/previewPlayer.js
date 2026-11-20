// @ts-check
/**
 * Lecteur de preview : un seul élément <audio> pour toute la page.
 * Démarre au début de preview de la chanson, joue 30 s puis s'arrête avec un fondu.
 * @module previewPlayer
 */
import { audioUrl } from './api.js';
import { fadeFactor, previewWindow, seekWindow } from './previewCore.js';

const VOLUME_KEY = 'usm.volume';
const DEFAULT_VOLUME = 0.8;

/** @typedef {import('./api.js').Song} Song */
/** @typedef {'idle' | 'loading' | 'playing' | 'paused' | 'error'} PlayerStatus */

/**
 * @typedef {object} PlayerState
 * @property {Song | null} song
 * @property {PlayerStatus} status
 * @property {number} currentTime  Position réelle dans la chanson (s).
 * @property {number} duration     Durée de la chanson (s), NaN si inconnue.
 * @property {{ start: number, end: number }} window  Extrait joué (s).
 * @property {number} remaining    Secondes restantes de l'extrait.
 * @property {number} volume     0 à 1.
 */

/** @returns {number} */
function readVolume() {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && stored >= 0 && stored <= 1
      ? stored
      : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

/**
 * @param {HTMLAudioElement} audio
 * @param {object} handlers
 * @param {(state: PlayerState) => void} handlers.onChange
 */
export function createPreviewPlayer(audio, { onChange }) {
  /** @type {PlayerState} */
  const state = {
    song: null,
    status: 'idle',
    currentTime: 0,
    duration: Number.NaN,
    window: { start: 0, end: 0 },
    remaining: 0,
    volume: readVolume(),
  };
  let window = { start: 0, end: 0 };
  /** Numéro de la lecture en cours : ignore les événements d'une lecture précédente. */
  let request = 0;

  /** @param {Partial<PlayerState>} changes */
  function update(changes) {
    Object.assign(state, changes);
    onChange({ ...state });
  }

  function stop() {
    request++;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio.volume = state.volume;
    update({
      song: null,
      status: 'idle',
      currentTime: 0,
      duration: Number.NaN,
      window: { start: 0, end: 0 },
      remaining: 0,
    });
  }

  /** @param {Song} song */
  function play(song) {
    const current = ++request;
    audio.pause();
    audio.volume = state.volume;
    update({
      song,
      status: 'loading',
      currentTime: 0,
      duration: Number.NaN,
      window: { start: 0, end: 0 },
      remaining: 0,
    });

    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (current !== request) return;
        window = previewWindow(song.previewStart, audio.duration);
        audio.currentTime = window.start;
        update({ duration: audio.duration, window, currentTime: window.start });
        audio.play().catch((error) => {
          if (current !== request) return;
          console.error(error);
          update({ status: 'error' });
        });
      },
      { once: true },
    );
    audio.src = audioUrl(song);
    audio.load();
  }

  audio.addEventListener('playing', () => update({ status: 'playing' }));
  audio.addEventListener('pause', () => {
    if (state.status === 'playing') update({ status: 'paused' });
  });
  audio.addEventListener('error', () => {
    if (state.song && audio.getAttribute('src')) update({ status: 'error' });
  });
  audio.addEventListener('timeupdate', () => {
    if (!state.song || state.status === 'loading') return;
    if (audio.currentTime >= window.end || audio.ended) {
      stop();
      return;
    }
    audio.volume = state.volume * fadeFactor(audio.currentTime, window.end);
    update({
      currentTime: audio.currentTime,
      remaining: Math.max(0, window.end - audio.currentTime),
    });
  });
  audio.addEventListener('ended', stop);

  return {
    /**
     * Lance la preview, ou met en pause / reprend si c'est déjà cette chanson.
     * @param {Song} song
     */
    toggle(song) {
      if (state.song?.id !== song.id || state.status === 'error') {
        play(song);
      } else if (state.status === 'playing') {
        audio.pause();
      } else if (state.status === 'paused') {
        audio.play().catch(console.error);
      }
    },

    stop,

    /**
     * Se déplace dans la chanson : un nouvel extrait de 30 s démarre à cette position.
     * Une lecture en pause reste en pause.
     * @param {number} seconds
     */
    seek(seconds) {
      if (!state.song || !Number.isFinite(state.duration) || state.status === 'loading') return;
      window = seekWindow(seconds, state.duration);
      audio.currentTime = window.start;
      audio.volume = state.volume;
      update({
        window,
        currentTime: window.start,
        remaining: Math.max(0, window.end - window.start),
      });
    },

    /** @param {number} volume 0 à 1 */
    setVolume(volume) {
      const clamped = Math.min(1, Math.max(0, volume));
      audio.volume = clamped * fadeFactor(audio.currentTime, window.end);
      try {
        localStorage.setItem(VOLUME_KEY, String(clamped));
      } catch {
        // le volume ne sera simplement pas mémorisé
      }
      update({ volume: clamped });
    },

    /** @returns {PlayerState} */
    getState() {
      return { ...state };
    },
  };
}
