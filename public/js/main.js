// @ts-check
/**
 * Point d'entrée du navigateur : assemble i18n, état du serveur, filtres et grille.
 * @module main
 */
import { facetImageUrl, getFacetImages, getHealth, getSongs } from './api.js';
import { createFiltersView } from './filtersView.js';
import { getLanguage, initI18n, onLanguageChange, t } from './i18n.js';
import { initLanguageSelector } from './languageSelector.js';
import { createPlayerBar } from './playerBar.js';
import { createPreviewPlayer } from './previewPlayer.js';
import {
  criteriaFromParams,
  criteriaToParams,
  defaultCriteria,
  facetOptions,
  filterSongs,
  normalizeText,
  sortSongs,
} from './songFilters.js';
import { createSongGrid } from './songGrid.js';

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
const byId = (id) => /** @type {T} */ (document.getElementById(id));

const statusBadge = byId('server-status');
const resultsCount = byId('results-count');

const player = createPreviewPlayer(/** @type {HTMLAudioElement} */ (byId('preview-player')), {
  onChange(playerState) {
    grid.setPlayback(playerState.song?.id ?? null, playerState.status);
    playerBar.render(playerState);
  },
});

const playerBar = createPlayerBar(byId('player-bar'), {
  onToggle() {
    const { song } = player.getState();
    if (song) player.toggle(song);
  },
  onStop: () => player.stop(),
  onVolume: (volume) => player.setVolume(volume),
  onSeek: (seconds) => player.seek(seconds),
});

const grid = createSongGrid({
  container: byId('song-grid'),
  sentinel: byId('song-grid-sentinel'),
  template: /** @type {HTMLTemplateElement} */ (byId('song-card-template')),
  onPreview(songId) {
    const song = state.songs.find((s) => s.id === songId);
    if (song) player.toggle(song);
  },
});

const filters = createFiltersView(
  { form: /** @type {HTMLFormElement} */ (byId('filters')), modal: byId('facet-modal') },
  {
    onChange(criteria) {
      state.criteria = criteria;
      applyFilters();
    },
    getFacetOptions: (key) => facetOptions(state.songs, state.criteria, key, getLanguage()),
    getImageUrl: (key, value) =>
      state.facetImages[key]?.has(normalizeText(value)) ? facetImageUrl(key, value) : null,
  },
);

/** @typedef {import('./api.js').Song} Song */

const state = {
  /** @type {'connecting' | 'ok' | 'error'} */ server: 'connecting',
  /** @type {string | null} */ version: null,
  /** @type {Song[]} */ songs: [],
  /** @type {string | null} */ catalogError: null,
  criteria: defaultCriteria(),
  /** Valeurs illustrées (texte normalisé) par facette. @type {Record<string, Set<string>>} */
  facetImages: {},
};

/**
 * Code d'erreur traduisible d'une exception.
 * @param {unknown} error
 * @returns {string}
 */
function errorCodeOf(error) {
  return error instanceof Error && 'code' in error ? String(error.code) : 'INTERNAL_ERROR';
}

/** Affiche l'état du serveur dans la langue courante. */
function renderStatus() {
  if (state.server === 'connecting') {
    statusBadge.textContent = t('status.connecting');
    statusBadge.className = 'badge text-bg-secondary';
  } else if (state.server === 'ok') {
    statusBadge.textContent = state.version
      ? t('status.okVersion', { version: state.version })
      : t('status.ok');
    statusBadge.className = 'badge text-bg-success';
  } else {
    statusBadge.textContent = t('status.unreachable');
    statusBadge.className = 'badge text-bg-danger';
  }
}

/** Garde les critères dans l'URL : un rechargement ou un favori conserve les filtres. */
function syncUrl() {
  const query = criteriaToParams(state.criteria).toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

/** Filtre, trie et affiche les chansons. */
function applyFilters() {
  if (state.catalogError) {
    grid.showError(t(`errors.${state.catalogError}`));
    resultsCount.textContent = '';
    filters.update(state.criteria, 0);
    return;
  }
  const visible = sortSongs(
    filterSongs(state.songs, state.criteria),
    state.criteria.sort,
    getLanguage(),
  );
  grid.render(visible);
  resultsCount.textContent = t('songs.shown', {
    count: visible.length,
    total: state.songs.length,
  });
  filters.update(state.criteria, visible.length);
  syncUrl();
}

async function checkServer() {
  try {
    const { version } = await getHealth();
    Object.assign(state, { server: 'ok', version });
  } catch (error) {
    console.error(error);
    state.server = 'error';
  }
  renderStatus();
}

async function loadCatalog() {
  try {
    const { data } = await getSongs();
    state.songs = data;
    state.catalogError = null;
  } catch (error) {
    console.error(error);
    state.catalogError = errorCodeOf(error);
  }
  applyFilters();
}

/** Charge la liste des images de catégories (facultatif : sans elle, tuiles avec initiales). */
async function loadFacetImages() {
  try {
    const { data } = await getFacetImages();
    state.facetImages = Object.fromEntries(
      Object.entries(data).map(([key, values]) => [key, new Set(values.map(normalizeText))]),
    );
  } catch (error) {
    console.error(error);
  }
}

async function init() {
  await initI18n();
  initLanguageSelector(byId('language-select'));
  state.criteria = criteriaFromParams(new URLSearchParams(location.search));
  filters.update(state.criteria, 0);
  renderStatus();

  onLanguageChange(() => {
    renderStatus();
    applyFilters();
    playerBar.render(player.getState());
  });

  // Échap arrête la preview (sauf pendant la saisie dans la recherche).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.target instanceof HTMLInputElement) return;
    if (filters.isOpen()) return; // Échap ferme d'abord la fenêtre de filtres
    player.stop();
  });
  playerBar.render(player.getState());

  await Promise.all([checkServer(), loadCatalog(), loadFacetImages()]);
}

init().catch(console.error);
