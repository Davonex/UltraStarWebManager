// @ts-check
/**
 * Barre de lecture en bas de l'écran (affichée seulement pendant une preview).
 * @module playerBar
 */
import { coverUrl } from './api.js';
import { t } from './i18n.js';
import { formatTime, positionFromPointer, songFraction } from './previewCore.js';

const PLACEHOLDER_COVER = '/img/no-cover.svg';

/** @typedef {import('./previewPlayer.js').PlayerState} PlayerState */

/**
 * @param {HTMLElement} root
 * @param {object} handlers
 * @param {() => void} handlers.onToggle
 * @param {() => void} handlers.onStop
 * @param {(volume: number) => void} handlers.onVolume
 * @param {(seconds: number) => void} handlers.onSeek  Déplacement dans la chanson.
 * @param {() => void} handlers.onToggleVideo  Affiche / masque la vidéo.
 */
export function createPlayerBar(root, { onToggle, onStop, onVolume, onSeek, onToggleVideo }) {
  /** @param {string} selector */
  const $ = (selector) => /** @type {HTMLElement} */ (root.querySelector(selector));
  const cover = /** @type {HTMLImageElement} */ ($('.player-cover'));
  const title = $('.player-title');
  const artist = $('.player-artist');
  const status = $('.player-status');
  const track = $('.progress-track');
  const progressBar = $('.progress-bar');
  const previewZone = $('.progress-preview');
  const toggleButton = /** @type {HTMLButtonElement} */ ($('[data-action="toggle"]'));
  const volume = /** @type {HTMLInputElement} */ ($('input[name="volume"]'));
  /** @type {string | null} */
  let shownSongId = null;
  /** Dernier état affiché (durée, position) pour le curseur. */
  /** @type {PlayerState | null} */
  let last = null;
  /** Position affichée pendant un glisser, avant le relâchement. */
  /** @type {number | null} */
  let dragging = null;

  /** Pas des flèches du clavier (s). */
  const KEYBOARD_STEP_S = 5;

  /** @returns {boolean} */
  const canSeek = () =>
    last !== null &&
    Number.isFinite(last.duration) &&
    (last.status === 'playing' || last.status === 'paused');

  /** @param {PointerEvent} event */
  const pointerPosition = (event) =>
    positionFromPointer(event.clientX, track.getBoundingClientRect(), last?.duration ?? Number.NaN);

  /** Affiche la position (réelle, ou celle du glisser en cours). */
  function renderPosition() {
    if (!last) return;
    const current = dragging ?? last.currentTime;
    const percent = songFraction(current, last.duration) * 100;
    progressBar.style.width = `${percent}%`;
    const text = t('player.position', {
      current: formatTime(current),
      total: formatTime(last.duration),
    });
    track.setAttribute('aria-valuemax', String(Math.round(last.duration || 0)));
    track.setAttribute('aria-valuenow', String(Math.round(current)));
    track.setAttribute('aria-valuetext', text);
    if (last.status === 'playing' || last.status === 'paused') status.textContent = text;
    return text;
  }

  track.addEventListener('pointerdown', (event) => {
    if (!canSeek()) return;
    track.setPointerCapture(event.pointerId);
    dragging = pointerPosition(event);
    renderPosition();
  });
  track.addEventListener('pointermove', (event) => {
    if (!canSeek()) return;
    const position = pointerPosition(event);
    track.title = formatTime(position); // infobulle : temps sous le pointeur
    if (dragging === null) return;
    dragging = position;
    renderPosition();
  });
  track.addEventListener('pointerup', (event) => {
    if (dragging === null) return;
    track.releasePointerCapture(event.pointerId);
    const target = dragging;
    dragging = null;
    onSeek(target);
  });
  track.addEventListener('pointercancel', () => {
    dragging = null;
    renderPosition();
  });
  track.addEventListener('keydown', (event) => {
    if (!canSeek() || !last) return;
    /** @type {Record<string, number>} */
    const targets = {
      ArrowLeft: last.currentTime - KEYBOARD_STEP_S,
      ArrowDown: last.currentTime - KEYBOARD_STEP_S,
      ArrowRight: last.currentTime + KEYBOARD_STEP_S,
      ArrowUp: last.currentTime + KEYBOARD_STEP_S,
      Home: 0,
      End: last.duration,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    onSeek(targets[event.key]);
  });

  const videoButton = /** @type {HTMLButtonElement} */ ($('[data-action="video"]'));
  toggleButton.addEventListener('click', onToggle);
  videoButton.addEventListener('click', onToggleVideo);
  $('[data-action="stop"]').addEventListener('click', onStop);
  volume.addEventListener('input', () => onVolume(Number(volume.value) / 100));
  cover.addEventListener('error', () => {
    cover.src = PLACEHOLDER_COVER;
  });

  return {
    /**
     * @param {PlayerState} state
     * @param {{ available: boolean, enabled: boolean }} [video]  Vidéo de la chanson en cours.
     */
    render(state, video = { available: false, enabled: false }) {
      videoButton.hidden = !video.available;
      videoButton.classList.toggle('active', video.enabled);
      videoButton.setAttribute('aria-pressed', String(video.enabled));
      const videoLabel = t(video.enabled ? 'player.hideVideo' : 'player.showVideo');
      videoButton.title = videoLabel;
      videoButton.setAttribute('aria-label', videoLabel);
      root.hidden = state.song === null;
      volume.value = String(Math.round(state.volume * 100));
      if (!state.song) {
        shownSongId = null;
        last = null;
        dragging = null;
        return;
      }
      const { song } = state;
      if (shownSongId !== song.id) {
        shownSongId = song.id;
        cover.src = coverUrl(song) ?? PLACEHOLDER_COVER;
      }
      title.textContent = song.title ?? t('songs.unknownTitle');
      artist.textContent = song.artist ?? t('songs.unknownArtist');

      const isPlaying = state.status === 'playing';
      toggleButton.dataset.state =
        state.status === 'loading' ? 'loading' : isPlaying ? 'pause' : 'play';
      toggleButton.setAttribute('aria-label', t(isPlaying ? 'player.pause' : 'player.resume'));
      toggleButton.title = toggleButton.getAttribute('aria-label') ?? '';
      toggleButton.disabled = state.status === 'loading' || state.status === 'error';

      last = state;
      const position = renderPosition() ?? '';
      track.classList.toggle('is-seekable', canSeek());
      status.textContent =
        state.status === 'loading'
          ? t('player.loading')
          : state.status === 'error'
            ? t('player.error')
            : position;
      status.title =
        state.status === 'playing' || state.status === 'paused'
          ? t('player.remaining', { seconds: Math.ceil(state.remaining) })
          : '';
      status.classList.toggle('text-danger', state.status === 'error');

      // Barre = chanson entière ; zone claire = extrait ; trait bleu = position réelle.
      const zoneStart = songFraction(state.window.start, state.duration);
      const zoneEnd = songFraction(state.window.end, state.duration);
      previewZone.style.left = `${zoneStart * 100}%`;
      previewZone.style.width = `${(zoneEnd - zoneStart) * 100}%`;
    },
  };
}
