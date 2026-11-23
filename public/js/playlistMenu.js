// @ts-check
/**
 * Menu « Playlists » de la barre de lecture : les playlists de la bibliothèque, cochées pour
 * celles qui contiennent la chanson en cours. Cocher l'ajoute, décocher la retire
 * (niveau écriture ; en lecture, les cases sont seulement indicatives).
 *
 * @module playlistMenu
 */
import { ApiError, addSongToPlaylist, removeSongFromPlaylist } from './api.js';
import { t } from './i18n.js';

/** @typedef {import('./api.js').Song} Song */
/** @typedef {import('./api.js').Playlist} Playlist */

/** @param {unknown} error */
function errorText(error) {
  if (!(error instanceof ApiError)) return t('errors.NETWORK_ERROR');
  const key = `errors.${error.code}`;
  const text = t(key, error.params);
  return text === key ? error.message : text;
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} root  Conteneur .dropup (bouton + .dropdown-menu).
 * @param {object} handlers
 * @param {() => Song | null} handlers.getSong        Chanson en cours de lecture.
 * @param {() => Playlist[]} handlers.getPlaylists
 * @param {() => boolean} handlers.canEdit
 * @param {(playlist: Playlist) => void} handlers.onChanged  Playlist relue après écriture.
 */
export function createPlaylistMenu(root, { getSong, getPlaylists, canEdit, onChanged }) {
  const menu = /** @type {HTMLElement} */ (root.querySelector('.dropdown-menu'));
  /** Playlist en cours d'écriture (case désactivée pendant ce temps). @type {string | null} */
  let busyFile = null;
  /** @type {string | null} */
  let error = null;

  /**
   * @param {Playlist} playlist
   * @param {Song} song
   * @param {boolean} add
   */
  async function change(playlist, song, add) {
    busyFile = playlist.file;
    error = null;
    render();
    try {
      const body = { songId: song.id, expectedModifiedAt: playlist.modifiedAt };
      const { data } = await (add
        ? addSongToPlaylist(playlist.file, body)
        : removeSongFromPlaylist(playlist.file, body));
      if (data.playlist) onChanged(data.playlist);
    } catch (err) {
      error = errorText(err);
    } finally {
      busyFile = null;
    }
    render();
  }

  function render() {
    const song = getSong();
    const playlists = getPlaylists();
    /** @type {Node[]} */
    const content = [];
    const heading = el('h6', 'dropdown-header px-1', t('playlists.title'));
    content.push(heading);
    if (song) {
      content.push(
        el(
          'p',
          'small text-body-secondary px-1 mb-2 text-truncate',
          [song.artist, song.title].filter(Boolean).join(' – '),
        ),
      );
    }
    if (error) {
      const alert = el('div', 'alert alert-danger py-1 px-2 small mb-2', error);
      alert.setAttribute('role', 'alert');
      content.push(alert);
    }
    if (playlists.length === 0) {
      content.push(el('p', 'small px-1 mb-0', t('playlists.none')));
    } else if (song) {
      const editable = canEdit();
      const list = el('div', 'playlist-menu-list');
      for (const playlist of playlists) {
        const contains = playlist.songIds.includes(song.id);
        const label = el('label', 'form-check playlist-menu-item');
        const input = /** @type {HTMLInputElement} */ (el('input', 'form-check-input'));
        input.type = 'checkbox';
        input.checked = contains;
        input.disabled = !editable || busyFile !== null;
        input.addEventListener('change', () => change(playlist, song, input.checked));
        const name = el('span', 'form-check-label', playlist.name);
        const count = el(
          'small',
          'text-body-secondary ms-auto ps-2',
          t('playlists.count', { count: playlist.songIds.length }),
        );
        label.append(input, name, count);
        if (busyFile === playlist.file)
          label.append(el('span', 'spinner-border spinner-border-sm ms-2'));
        list.append(label);
      }
      content.push(list);
      if (!editable)
        content.push(el('p', 'small text-body-secondary px-1 mt-2 mb-0', t('playlists.readOnly')));
    }
    menu.replaceChildren(...content);
  }

  // Liste à jour à chaque ouverture (la chanson en cours a pu changer).
  root.addEventListener('show.bs.dropdown', () => {
    error = null;
    render();
  });

  return {
    /**
     * Affiche le bouton seulement si des playlists sont configurées.
     * @param {boolean} visible
     */
    setVisible(visible) {
      root.hidden = !visible;
    },

    /** Retraduit / met à jour le menu s'il est ouvert. */
    refresh() {
      if (menu.classList.contains('show')) render();
    },
  };
}
