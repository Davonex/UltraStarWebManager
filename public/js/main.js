// @ts-check
/**
 * Point d'entrée du navigateur : assemble i18n, état du serveur, filtres et grille.
 * @module main
 */
import {
  coverUrl,
  facetImageUrl,
  getFacetImages,
  getHealth,
  getMe,
  getPlaylists,
  getSongs,
  rescanCatalog,
} from './api.js';
import { createAuthView } from './authView.js';
import { createBulkTools } from './bulkTools.js';
import { createBulkVideoTool } from './bulkVideoTool.js';
import { createFiltersView } from './filtersView.js';
import { getLanguage, initI18n, onLanguageChange, t } from './i18n.js';
import { initLanguageSelector } from './languageSelector.js';
import { createPlayerBar } from './playerBar.js';
import { pickMosaicSongs } from './playlistCovers.js';
import { createPlaylistMenu } from './playlistMenu.js';
import { createPreviewPlayer } from './previewPlayer.js';
import { createSongDetailsView } from './songDetails.js';
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
import { createVideoPanel } from './videoPanel.js';

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
const byId = (id) => /** @type {T} */ (document.getElementById(id));

const statusBadge = byId('server-status');
const resultsCount = byId('results-count');

const videoPanel = createVideoPanel(byId('video-panel'));
const videoSwitch = /** @type {HTMLInputElement} */ (byId('video-switch'));
const rescanButton = /** @type {HTMLButtonElement} */ (byId('rescan-button'));
const bulkButton = /** @type {HTMLButtonElement} */ (byId('bulk-button'));
const playlistChip = /** @type {HTMLElement} */ (document.querySelector('[data-facet="playlist"]'));
/** Niveaux d'accès, du plus faible au plus fort (comme côté serveur). */
const ROLE_ORDER = ['read', 'write', 'admin'];

/**
 * Met à jour la barre de lecture (avec l'état du bouton vidéo).
 * @param {import('./previewPlayer.js').PlayerState} playerState
 */
function renderPlayerBar(playerState) {
  playerBar.render(playerState, {
    available: videoPanel.isAvailable(playerState.song),
    enabled: videoPanel.isEnabled(),
  });
}

const player = createPreviewPlayer(/** @type {HTMLAudioElement} */ (byId('preview-player')), {
  onChange(playerState) {
    grid.setPlayback(playerState.song?.id ?? null, playerState.status);
    videoPanel.sync(playerState);
    renderPlayerBar(playerState);
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
  onToggleVideo() {
    videoPanel.toggle();
    videoSwitch.checked = videoPanel.isEnabled();
    renderPlayerBar(player.getState());
  },
});

const grid = createSongGrid({
  container: byId('song-grid'),
  sentinel: byId('song-grid-sentinel'),
  template: /** @type {HTMLTemplateElement} */ (byId('song-card-template')),
  onPreview(songId) {
    const song = state.songs.find((s) => s.id === songId);
    if (song) player.toggle(song);
  },
  onInfo(songId) {
    const song = state.songs.find((s) => s.id === songId);
    if (song) songDetails.open(song);
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
    getImageUrl: (key, value) => imageUrlFor(key, value),
    getMosaicUrls: (key, value) => (key === 'playlist' ? playlistCovers(value) : []),
  },
);

/** @typedef {import('./api.js').Song} Song */

const state = {
  /** @type {'connecting' | 'ok' | 'error'} */ server: 'connecting',
  /** @type {string | null} */ version: null,
  /** @type {Song[]} */ songs: [],
  /** @type {string | null} */ catalogError: null,
  criteria: defaultCriteria(),
  /** @type {import('./api.js').Role | null} */ role: null,
  /** Valeurs illustrées (texte normalisé) par facette. @type {Record<string, Set<string>>} */
  facetImages: {},
  /** Playlists .upl (PLAYLIST_DIR). @type {import('./api.js').Playlist[]} */
  playlists: [],
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
    if (state.catalogError === 'AUTH_REQUIRED') authView.showLogin(); // session expirée
  }
  if (!state.catalogError) await loadPlaylists(); // relie les chansons à leurs playlists
  applyFilters();
}

/**
 * Charge les playlists et indique à chaque chanson celles qui la contiennent
 * (facette « Playlists »). Sans playlist, la pastille reste cachée.
 */
async function loadPlaylists() {
  try {
    const { data, meta } = await getPlaylists();
    state.playlists = data;
    playlistMenu.setVisible(meta.configured);
  } catch (error) {
    console.error(error);
    state.playlists = [];
    playlistMenu.setVisible(false);
  }
  linkSongsToPlaylists();
}

/** Indique à chaque chanson les playlists qui la contiennent (facette « Playlists »). */
function linkSongsToPlaylists() {
  /** @type {Map<string, string[]>} */
  const names = new Map();
  for (const playlist of state.playlists) {
    for (const id of playlist.songIds) names.set(id, [...(names.get(id) ?? []), playlist.name]);
  }
  state.songs = state.songs.map((song) => ({ ...song, playlists: names.get(song.id) ?? [] }));
  playlistChip.hidden = state.playlists.length === 0;
}

/** Menu « Playlists » de la barre de lecture : ajout / retrait de la chanson en cours. */
const playlistMenu = createPlaylistMenu(
  /** @type {HTMLElement} */ (document.querySelector('.player-playlists')),
  {
    getSong: () => player.getState().song,
    getPlaylists: () => state.playlists,
    canEdit: () => ROLE_ORDER.indexOf(state.role ?? '') >= ROLE_ORDER.indexOf('write'),
    onChanged(playlist) {
      state.playlists = state.playlists.map((p) => (p.file === playlist.file ? playlist : p));
      linkSongsToPlaylists();
      applyFilters();
    },
  },
);

/**
 * Pochettes de la mosaïque d'une playlist (ses premières chansons avec pochette).
 * @param {string} name
 * @returns {string[]}
 */
function playlistCovers(name) {
  const playlist = state.playlists.find((p) => p.name === name);
  if (!playlist) return [];
  const songsById = new Map(state.songs.map((song) => [song.id, song]));
  return pickMosaicSongs(playlist.songIds, songsById)
    .map((song) => coverUrl(song))
    .filter((url) => url !== null);
}

/**
 * URL de l'image d'une valeur de facette, si UltraStar en fournit une.
 * @param {string} key
 * @param {string} value
 * @returns {string | null}
 */
function imageUrlFor(key, value) {
  return state.facetImages[key]?.has(imageKey(value)) ? facetImageUrl(key, value) : null;
}

/**
 * Clé de comparaison des images : sans casse ni accents, « _ » = espace
 * (« Love Song », « LOVE_SONG » et « love song » sont la même image).
 * @param {string} value
 * @returns {string}
 */
function imageKey(value) {
  return normalizeText(value.replace(/_/g, ' '));
}

const songDetails = createSongDetailsView(
  { modal: byId('song-modal'), musicBrainzModal: byId('musicbrainz-modal') },
  {
    getImageUrl: imageUrlFor,
    onPlay: (song) => player.toggle(song),
    canEdit: () => ROLE_ORDER.indexOf(state.role ?? '') >= ROLE_ORDER.indexOf('write'),
    getSuggestions: (header) => suggestionsFor(header),
    onSongUpdated(song) {
      // La chanson revient du serveur sans ses playlists : on garde celles déjà connues.
      state.songs = state.songs.map((s) =>
        s.id === song.id ? { ...song, playlists: s.playlists } : s,
      );
      applyFilters();
    },
  },
);

/**
 * Valeurs existantes dans la bibliothèque, proposées lors d'une modification.
 * @param {'EDITION' | 'TAGS' | 'CREATOR'} header
 * @returns {string[]}
 */
function suggestionsFor(header) {
  /** @type {Record<string, (song: Song) => string[]>} */
  const pick = { EDITION: (s) => s.editions, TAGS: (s) => s.tags, CREATOR: (s) => s.creators };
  /** @type {Map<string, string>} */
  const byKey = new Map();
  for (const song of state.songs) {
    for (const value of pick[header](song)) {
      const key = normalizeText(value);
      if (key && !byKey.has(key)) byKey.set(key, value);
    }
  }
  const collator = new Intl.Collator(getLanguage(), { sensitivity: 'base', numeric: true });
  return [...byKey.values()].sort(collator.compare);
}

const authView = createAuthView({
  badge: byId('role-badge'),
  loginButton: /** @type {HTMLButtonElement} */ (byId('login-button')),
  logoutButton: /** @type {HTMLButtonElement} */ (byId('logout-button')),
  modal: byId('login-modal'),
});

/** Interrupteur « Vidéos » : même réglage que le bouton vidéo de la barre de lecture. */
videoSwitch.checked = videoPanel.isEnabled();
videoSwitch.addEventListener('change', () => {
  videoPanel.setEnabled(videoSwitch.checked);
  renderPlayerBar(player.getState());
});

/** Corrections en masse : après une conversion, on recharge la liste (avertissements à jour). */
const bulkTools = createBulkTools({ modal: byId('bulk-modal'), onDone: loadCatalog });
const bulkVideoTool = createBulkVideoTool({ modal: byId('bulk-modal'), onDone: loadCatalog });

/** Bouton « Actualiser » : relit les fichiers .txt puis recharge la liste. */
rescanButton.addEventListener('click', async () => {
  rescanButton.disabled = true;
  rescanButton.classList.add('is-busy');
  try {
    const { data } = await rescanCatalog();
    await loadCatalog();
    resultsCount.textContent = `${resultsCount.textContent} · ${t('catalog.rescanned', {
      seconds: (data.durationMs / 1000).toLocaleString(getLanguage(), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    })}`;
  } catch (error) {
    console.error(error);
    resultsCount.textContent = t(`errors.${errorCodeOf(error)}`);
  } finally {
    rescanButton.disabled = false;
    rescanButton.classList.remove('is-busy');
  }
});

/** Charge la liste des images de catégories (facultatif : sans elle, tuiles avec initiales). */
async function loadFacetImages() {
  try {
    const { data } = await getFacetImages();
    state.facetImages = Object.fromEntries(
      Object.entries(data).map(([key, values]) => [key, new Set(values.map(imageKey))]),
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
    authView.refresh();
    songDetails.refresh();
    bulkTools.refresh();
    bulkVideoTool.refresh();
    playlistMenu.refresh();
    renderStatus();
    applyFilters();
    renderPlayerBar(player.getState());
  });

  // Échap arrête la preview (sauf pendant la saisie dans la recherche).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.target instanceof HTMLInputElement) return;
    if (document.body.classList.contains('modal-open')) return; // Échap ferme d'abord la fenêtre ouverte
    player.stop();
  });
  renderPlayerBar(player.getState());

  // Droits d'accès : sans connexion, on affiche seulement la fenêtre de connexion.
  const loginError = new URLSearchParams(location.search).get('login'); // retour de /login?key=…
  const { data: me } = await getMe();
  state.role = me.role;
  authView.setState(me);
  const canWrite = ROLE_ORDER.indexOf(me.role ?? '') >= ROLE_ORDER.indexOf('write');
  rescanButton.hidden = !canWrite;
  bulkButton.hidden = !canWrite;
  if (!me.role) {
    await checkServer();
    authView.showLogin(loginError);
    return;
  }
  await Promise.all([checkServer(), loadCatalog(), loadFacetImages()]);
}

init().catch(console.error);
