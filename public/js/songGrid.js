// @ts-check
/**
 * Grille des chansons (cartes avec pochette), affichée par pages au fil du défilement
 * pour rester fluide avec des milliers de chansons.
 * @module songGrid
 */
import { coverUrl } from './api.js';
import { t } from './i18n.js';

/** Nombre de cartes ajoutées à chaque page. */
const PAGE_SIZE = 96;
/** Distance avant le bas de page à partir de laquelle on charge la suite. */
const PRELOAD_MARGIN = '800px';
const PLACEHOLDER_COVER = '/img/no-cover.svg';

/** @typedef {import('./api.js').Song} Song */
/** @typedef {import('./api.js').SongWarning} SongWarning */

/**
 * Texte traduit d'un avertissement, avec repli sur le message anglais du serveur.
 * @param {SongWarning} warning
 * @returns {string}
 */
function warningText(warning) {
  const key = `warnings.${warning.code}`;
  const text = t(key, warning.params);
  return text === key ? warning.message : text;
}

/**
 * @param {string} text
 * @param {string} className
 * @param {string} [title]
 */
function badge(text, className, title) {
  const el = document.createElement('span');
  el.className = `badge ${className}`;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

/** @typedef {import('./previewPlayer.js').PlayerStatus} PlayerStatus */

/**
 * @param {object} elements
 * @param {HTMLElement} elements.container  Rangée Bootstrap qui reçoit les cartes.
 * @param {HTMLElement} elements.sentinel   Élément observé en bas de grille.
 * @param {HTMLTemplateElement} elements.template  Modèle d'une carte.
 * @param {(songId: string) => void} elements.onPreview  Clic sur le bouton de lecture.
 */
export function createSongGrid({ container, sentinel, template, onPreview }) {
  /** @type {readonly Song[]} */
  let songs = [];
  let rendered = 0;
  /** @type {{ songId: string | null, status: PlayerStatus }} */
  let playback = { songId: null, status: 'idle' };

  /**
   * Met à jour le bouton et le style d'une carte selon l'état de lecture.
   * @param {HTMLElement} card
   * @param {PlayerStatus} status
   */
  function applyPlayback(card, status) {
    const button = /** @type {HTMLButtonElement | null} */ (card.querySelector('.song-play'));
    if (!button || button.disabled) return;
    const isPlaying = status === 'playing';
    card.classList.toggle('is-playing', status !== 'idle');
    button.dataset.state = status === 'loading' ? 'loading' : isPlaying ? 'pause' : 'play';
    const title = card.querySelector('.song-title')?.textContent ?? '';
    const label = t(isPlaying ? 'player.pauseSong' : 'player.playSong', { title });
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  container.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('[data-action="preview"]');
    const card = button?.closest('.song-card');
    if (card instanceof HTMLElement && card.dataset.songId) onPreview(card.dataset.songId);
  });

  /**
   * @param {Song} song
   * @returns {DocumentFragment}
   */
  function createCard(song) {
    const fragment = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
    const card = /** @type {HTMLElement} */ (fragment.querySelector('.song-card'));
    const img = /** @type {HTMLImageElement} */ (fragment.querySelector('.song-cover'));
    const title = /** @type {HTMLElement} */ (fragment.querySelector('.song-title'));
    const artist = /** @type {HTMLElement} */ (fragment.querySelector('.song-artist'));
    const badges = /** @type {HTMLElement} */ (fragment.querySelector('.song-badges'));

    card.dataset.songId = song.id;
    title.textContent = song.title ?? t('songs.unknownTitle');
    title.title = title.textContent;
    artist.textContent = song.artist ?? t('songs.unknownArtist');
    artist.title = artist.textContent;

    img.alt = t('songs.coverAlt', { title: title.textContent, artist: artist.textContent });
    img.addEventListener(
      'error',
      () => {
        img.src = PLACEHOLDER_COVER;
      },
      { once: true },
    );
    img.src = coverUrl(song) ?? PLACEHOLDER_COVER;

    const playButton = /** @type {HTMLButtonElement} */ (fragment.querySelector('.song-play'));
    if (song.files.audio) {
      applyPlayback(card, playback.songId === song.id ? playback.status : 'idle');
    } else {
      playButton.disabled = true;
      playButton.title = t('player.noAudio');
      playButton.setAttribute('aria-label', playButton.title);
    }

    if (song.isDuet) badges.append(badge(t('songs.duet'), 'text-bg-info'));
    if (song.warnings.length > 0) {
      badges.append(
        badge(
          `⚠ ${song.warnings.length}`,
          'text-bg-warning',
          song.warnings.map(warningText).join('\n'),
        ),
      );
    }
    return fragment;
  }

  function renderNextPage() {
    if (rendered >= songs.length) return;
    const page = songs.slice(rendered, rendered + PAGE_SIZE);
    const fragment = document.createDocumentFragment();
    for (const song of page) fragment.append(createCard(song));
    container.append(fragment);
    rendered += page.length;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderNextPage();
    },
    { rootMargin: PRELOAD_MARGIN },
  );
  observer.observe(sentinel);

  /**
   * @param {string} text
   * @param {string} className
   */
  function showMessage(text, className) {
    const message = document.createElement('p');
    message.className = `col-12 ${className}`;
    message.textContent = text;
    container.replaceChildren(message);
  }

  return {
    /**
     * Affiche une nouvelle liste (repart du haut).
     * @param {readonly Song[]} list
     */
    render(list) {
      songs = list;
      rendered = 0;
      container.replaceChildren();
      if (list.length === 0) {
        showMessage(t('songs.noResults'), 'text-body-secondary');
        return;
      }
      renderNextPage();
    },

    /**
     * Reflète l'état du lecteur sur les cartes affichées.
     * @param {string | null} songId
     * @param {PlayerStatus} status
     */
    setPlayback(songId, status) {
      const previous = playback.songId;
      playback = { songId, status };
      for (const id of new Set([previous, songId])) {
        if (!id) continue;
        const card = container.querySelector(`.song-card[data-song-id="${CSS.escape(id)}"]`);
        if (card instanceof HTMLElement) applyPlayback(card, id === songId ? status : 'idle');
      }
    },

    /** @param {string} text */
    showError(text) {
      songs = [];
      rendered = 0;
      showMessage(text, 'text-danger');
    },
  };
}
