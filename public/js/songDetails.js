// @ts-check
/**
 * Fenêtre « info » d'une chanson : pochette, informations, synchronisation, fichiers,
 * avertissements et autres en-têtes du .txt (relus à la demande sur le serveur).
 *
 * Tout le contenu vient des fichiers de l'utilisateur : il est inséré avec textContent,
 * jamais innerHTML.
 *
 * @module songDetails
 */
import {
  ApiError,
  convertSongToUtf8,
  convertSongVideo,
  coverUrl,
  extractSongAudio,
  getSongDetails,
  getVideoJob,
  repairSongText,
  songReplayGain,
  updateSongHeaders,
} from './api.js';
import { createChipsInput } from './chipsInput.js';
import { getLanguage, t } from './i18n.js';
import { createMusicBrainzDialog } from './musicBrainzPanel.js';
import { formatTime, videoMimeType } from './previewCore.js';
import { createRenameDialog } from './renameDialog.js';
import { warningType } from './songFilters.js';
import { warningIcon } from './warningIcons.js';

const ICONS = '/img/vendor/bootstrap-icons/icons.svg';
const PLACEHOLDER_COVER = '/img/no-cover.svg';

/** En-têtes déjà présentés ailleurs dans la fenêtre (le reste va dans « Autres en-têtes »). */
const SHOWN_HEADERS = new Set([
  'TITLE',
  'ARTIST',
  'LANGUAGE',
  'EDITION',
  'GENRE',
  'TAGS',
  'YEAR',
  'CREATOR',
  'AUTHOR',
  'VERSION',
  'ENCODING',
  'BPM',
  'GAP',
  'VIDEOGAP',
  'PREVIEWSTART',
  'MEDLEYSTARTBEAT',
  'MEDLEYENDBEAT',
  'START',
  'END',
  'MP3',
  'AUDIO',
  'VIDEO',
  'COVER',
  'BACKGROUND',
  'P1',
  'P2',
  'DUETSINGERP1',
  'DUETSINGERP2',
]);

/** @typedef {import('./api.js').Song} Song */
/** @typedef {'ARTIST' | 'TITLE' | 'EDITION' | 'TAGS' | 'CREATOR' | 'LANGUAGE' | 'GENRE' | 'YEAR' | 'P1' | 'P2'
 *   | 'BPM' | 'GAP' | 'VIDEOGAP' | 'PREVIEWSTART' | 'MEDLEYSTARTBEAT' | 'MEDLEYENDBEAT' | 'START' | 'END'} EditableHeader */

/** Avertissements corrigeables par une conversion en UTF-8. */
const ENCODING_WARNINGS = new Set(['ENCODING_NOT_UTF8', 'ENCODING_UTF8_BOM']);
/** Avertissements corrigés par la conversion vidéo. */
const VIDEO_WARNINGS = new Set(['VIDEO_NOT_H264', 'VIDEO_TOO_LARGE']);
/** Intervalle de suivi d'une conversion vidéo (ms). */
const VIDEO_POLL_MS = 1000;
/** Noms lisibles des codecs vidéo. */
const CODEC_LABELS = Object.freeze({
  h264: 'H.264',
  hevc: 'HEVC (H.265)',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg4: 'MPEG-4 Part 2',
});

/**
 * « MP4 · H.264 », « AVI · MPEG-4 Part 2 »…
 * @param {import('./api.js').VideoDetails} video
 */
function videoFormat(video) {
  const codec = video.codec
    ? /** @type {Record<string, string>} */ (CODEC_LABELS[video.codec] ?? video.codec.toUpperCase())
    : null;
  return [video.container.toUpperCase(), codec].filter(Boolean).join(' · ');
}

const EDIT_LABELS = Object.freeze({
  ARTIST: 'details.artist',
  TITLE: 'details.songTitle',
  EDITION: 'filters.edition',
  TAGS: 'filters.tag',
  CREATOR: 'details.creator',
  LANGUAGE: 'filters.language',
  GENRE: 'filters.genre',
  YEAR: 'details.year',
  P1: 'details.singer1',
  P2: 'details.singer2',
  BPM: 'timing.BPM',
  GAP: 'timing.GAP',
  VIDEOGAP: 'timing.VIDEOGAP',
  PREVIEWSTART: 'timing.PREVIEWSTART',
  MEDLEYSTARTBEAT: 'timing.MEDLEYSTARTBEAT',
  MEDLEYENDBEAT: 'timing.MEDLEYENDBEAT',
  START: 'timing.START',
  END: 'timing.END',
});
/** Synchronisation : saisie d'un nombre, valeur brute de l'en-tête (unité dans le libellé). */
const TIMING_FIELDS = new Set([
  'BPM',
  'GAP',
  'VIDEOGAP',
  'PREVIEWSTART',
  'MEDLEYSTARTBEAT',
  'MEDLEYENDBEAT',
  'START',
  'END',
]);
/** Champs à une seule valeur : saisie simple au lieu des pastilles. */
const SINGLE_VALUE_FIELDS = new Set(['ARTIST', 'TITLE', 'YEAR', 'P1', 'P2', ...TIMING_FIELDS]);
/** Artiste et titre : aussi appliqués aux autres .txt du dossier et aux playlists. */
const IDENTITY_FIELDS = new Set(['ARTIST', 'TITLE']);

/**
 * Phrase « aussi mis à jour : … » après un changement d'artiste ou de titre ('' sinon).
 * @param {{ related?: { updated: unknown[], failed: { txtFile: string }[] },
 *   playlists?: { updated: unknown[], failed: { file: string }[] } }} result
 */
export function propagationText(result) {
  const txt = result.related?.updated.length ?? 0;
  const playlists = result.playlists?.updated.length ?? 0;
  const failed = [
    ...(result.related?.failed.map((f) => f.txtFile) ?? []),
    ...(result.playlists?.failed.map((f) => f.file) ?? []),
  ];
  return [
    txt + playlists > 0 ? t('edit.identityPropagated', { txt, playlists }) : '',
    failed.length > 0 ? t('edit.identityFailed', { files: failed.join(', ') }) : '',
  ]
    .filter(Boolean)
    .join(' ');
}
/** @typedef {import('./api.js').SongDetails} SongDetails */

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Icône du sprite Bootstrap Icons.
 * @param {string} name
 * @param {string} [className]
 * @returns {SVGSVGElement}
 */
function icon(name, className = 'bi') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

/**
 * @param {number | null | undefined} value
 * @param {number} [digits]
 * @returns {string}
 */
function number(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString(getLanguage(), { maximumFractionDigits: digits });
}

/**
 * @param {number | null} seconds
 * @returns {string}
 */
function time(seconds) {
  if (seconds === null) return '—';
  const sign = seconds < 0 ? '-' : '';
  return `${sign}${formatTime(Math.abs(seconds))} (${number(seconds)} s)`;
}

/**
 * @param {object} elements
 * @param {HTMLElement} elements.modal
 * @param {HTMLElement} [elements.musicBrainzModal]  Fenêtre MusicBrainz (niveau écriture).
 * @param {HTMLElement} [elements.renameModal]  Fenêtre de renommage (niveau écriture).
 * @param {object} handlers
 * @param {(facet: 'language' | 'decade' | 'edition' | 'tag', value: string) => string | null} handlers.getImageUrl
 * @param {(song: Song) => void} handlers.onPlay
 * @param {() => boolean} handlers.canEdit  L'utilisateur a-t-il le niveau écriture ?
 * @param {(header: EditableHeader) => string[]} handlers.getSuggestions  Valeurs existantes.
 * @param {(song: Song) => void} handlers.onSongUpdated  Après un enregistrement.
 * @param {() => void} handlers.onBeforeApply  Avant un renommage : arrêter la lecture.
 * @param {(songId: string) => Promise<Song | null>} handlers.onRenamed  Après un renommage :
 *   recharge le catalogue et renvoie la chanson (nouvel identifiant), ou null.
 */
export function createSongDetailsView(
  { modal, musicBrainzModal, renameModal },
  { getImageUrl, onPlay, canEdit, getSuggestions, onSongUpdated, onBeforeApply, onRenamed },
) {
  /** @param {string} selector */
  const $ = (selector) => /** @type {HTMLElement} */ (modal.querySelector(selector));
  const background = /** @type {HTMLImageElement} */ ($('.song-details-bg'));
  const cover = /** @type {HTMLImageElement} */ ($('.song-details-cover'));
  const title = $('.song-details-title');
  const artist = $('.song-details-artist');
  const badges = $('.song-details-badges');
  const body = $('.modal-body');
  const playButton = $('[data-action="details-play"]');
  const bootstrapModal = /** @type {any} */ (globalThis).bootstrap.Modal.getOrCreateInstance(modal);

  /** @type {Song | null} */
  let current = null;
  /** @type {SongDetails | null} */
  let details = null;
  /** Numéro de la demande en cours (ignore les réponses d'une ouverture précédente). */
  let request = 0;
  /** Champ en cours de modification (double-clic), ou null. @type {EditableHeader | null} */
  let editing = null;
  /** Saisie en cours (gardée si l'enregistrement échoue). @type {string[] | null} */
  let pendingValues = null;
  /** Message affiché en haut de la fenêtre. @type {{ kind: 'success' | 'danger' | 'info', text: string } | null} */
  let message = null;
  /** Dernier message affiché (pour ne le faire défiler à l'écran qu'une fois). */
  let shownMessage = /** @type {typeof message} */ (null);
  let busy = false;
  /** Conversion vidéo proposée (confirmation affichée), ou null. */
  /** @type {{ from: string, to: string, replaces: boolean, keepOriginal: boolean } | null} */
  let videoPlan = null;
  /** Dernière conversion vidéo suivie (toutes chansons : une seule à la fois). */
  /** @type {import('./api.js').VideoJob | null} */
  let videoJob = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let videoTimer;
  /** Création du MP3 proposée (confirmation affichée), ou null. */
  /** @type {{ from: string, to: string, reuse: boolean } | null} */
  let audioPlan = null;
  /** ReplayGain mesuré, en attente de confirmation. */
  /** @type {{ trackGain: number, trackPeak: number, audioModifiedAt: number } | null} */
  let gainMeasure = null;
  /** Réparation du texte simulée (lignes modifiées), en attente de confirmation. */
  /** @type {{ line: number, before: string, after: string }[] | null} */
  let textRepair = null;

  /**
   * Fenêtre MusicBrainz (YEAR / GENRE / LANGUAGE) : la fenêtre info se ferme le temps du
   * choix, puis se rouvre (avec le message de réussite si des valeurs ont été appliquées).
   */
  const musicBrainz = musicBrainzModal
    ? createMusicBrainzDialog({
        modal: musicBrainzModal,
        onClosed(song, applied) {
          if (applied) onSongUpdated(song);
          const notice = applied
            ? {
                kind: /** @type {const} */ ('success'),
                text: [
                  t('musicbrainz.saved', { backup: applied.backup ?? '—' }),
                  propagationText(applied),
                ]
                  .filter(Boolean)
                  .join(' '),
              }
            : null;
          openDetails(song, notice);
        },
      })
    : null;

  /**
   * Fenêtre « Renommer selon la norme » : la fenêtre info se ferme le temps du renommage,
   * puis se rouvre sur la chanson (dont l'identifiant change avec son chemin).
   */
  const renamer = renameModal
    ? createRenameDialog({
        modal: renameModal,
        onBeforeApply,
        onClosed({ song, songId, changed }) {
          if (!changed) {
            openDetails(song);
            return;
          }
          onRenamed(songId).then((renamed) => {
            if (renamed) openDetails(renamed, { kind: 'success', text: t('rename.reopened') });
          });
        },
      })
    : null;

  /** Ferme la fenêtre info puis ouvre la fenêtre de renommage. */
  function openRename() {
    const song = current;
    if (!song || !renamer) return;
    modal.addEventListener('hidden.bs.modal', () => renamer.open(song), { once: true });
    bootstrapModal.hide();
  }

  /** Ferme la fenêtre info puis ouvre la fenêtre MusicBrainz. */
  function openMusicBrainz() {
    const song = current;
    if (!song || !musicBrainz) return;
    modal.addEventListener('hidden.bs.modal', () => musicBrainz.open(song), { once: true });
    bootstrapModal.hide();
  }

  for (const img of [cover, background]) {
    img.addEventListener('error', () => {
      img.src = PLACEHOLDER_COVER;
    });
  }
  playButton.addEventListener('click', () => {
    if (!current) return;
    bootstrapModal.hide();
    onPlay(current);
  });

  // --- Briques d'affichage -------------------------------------------------------------

  /**
   * Section avec titre et liste de lignes « libellé : valeur ».
   * @param {string} iconName
   * @param {string} heading
   * @param {[string, string, Node | string][]} rows  [icône, libellé, valeur]
   * @param {Node} [action]  Bouton affiché à droite du titre.
   * @returns {HTMLElement}
   */
  function section(iconName, heading, rows, action) {
    const block = el('section', 'details-section');
    const h = el('h3', 'details-heading');
    h.append(icon(iconName), el('span', '', heading));
    if (action) h.append(action);
    const list = el('dl', 'details-list');
    for (const [rowIcon, label, value] of rows) {
      const row = el('div', 'details-row');
      const dt = el('dt');
      dt.append(icon(rowIcon, 'bi details-row-icon'), el('span', '', label));
      const dd = el('dd');
      dd.append(value);
      row.append(dt, dd);
      list.append(row);
    }
    block.append(h, list);
    return block;
  }

  /**
   * Pastilles de valeurs (avec l'image de la catégorie quand elle existe).
   * @param {'language' | 'edition' | 'tag' | null} facet
   * @param {string[]} values
   * @returns {Node | string}
   */
  function chips(facet, values) {
    if (values.length === 0) return '—';
    const wrap = el('div', 'details-chips');
    for (const value of values) {
      const chip = el('span', 'details-chip');
      const url = facet ? getImageUrl(facet, value) : null;
      if (url) {
        const img = /** @type {HTMLImageElement} */ (el('img', 'details-chip-img'));
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => img.remove(), { once: true });
        chip.append(img);
      }
      chip.append(el('span', '', value));
      wrap.append(chip);
    }
    return wrap;
  }

  /**
   * État d'un fichier référencé : présent, manquant, ou non renseigné.
   * @param {string | null} found       Nom réel trouvé sur le disque.
   * @param {string | undefined} declared  Nom indiqué dans le .txt.
   * @param {string} [note]
   * @returns {Node}
   */
  function fileState(found, declared, note) {
    const wrap = el('span', 'details-file');
    if (found) {
      wrap.append(icon('check-circle-fill', 'bi text-success'), el('span', '', found));
      if (note) wrap.append(el('small', 'text-body-secondary', ` (${note})`));
    } else if (declared) {
      wrap.append(icon('x-circle-fill', 'bi text-danger'), el('span', 'text-danger', declared));
      wrap.append(el('small', 'text-body-secondary', ` (${t('details.missing')})`));
    } else {
      wrap.append(
        icon('dash-circle', 'bi text-body-secondary'),
        el('span', 'text-body-secondary', t('details.none')),
      );
    }
    return wrap;
  }

  // --- Rendu ---------------------------------------------------------------------------

  function renderHeader() {
    if (!current) return;
    const song = current;
    const url = coverUrl(song) ?? PLACEHOLDER_COVER;
    cover.src = url;
    background.src = url;
    cover.alt = t('songs.coverAlt', { title: song.title ?? '', artist: song.artist ?? '' });
    title.textContent = song.title ?? t('songs.unknownTitle');
    artist.textContent = song.artist ?? t('songs.unknownArtist');
    playButton.hidden = !song.files.audio;
    playButton.setAttribute('aria-label', t('player.playSong', { title: title.textContent }));
    playButton.title = playButton.getAttribute('aria-label') ?? '';

    const items = [];
    if (song.year) items.push(el('span', 'badge text-bg-secondary', String(song.year)));
    if (song.isDuet) items.push(el('span', 'badge text-bg-info', t('songs.duet')));
    if (song.files.video) items.push(el('span', 'badge text-bg-dark', t('details.hasVideo')));
    if (song.warnings.length > 0) {
      items.push(el('span', 'badge text-bg-warning', `⚠ ${song.warnings.length}`));
    }
    badges.replaceChildren(...items);
  }

  /** Bandeau de message (succès, erreur, information) en haut de la fenêtre. */
  function messageBlock() {
    if (!message) return null;
    const alert = el('div', `alert alert-${message.kind} py-2 small`, message.text);
    alert.setAttribute('role', message.kind === 'danger' ? 'alert' : 'status');
    return alert;
  }

  /**
   * Libellé d'un en-tête modifiable.
   * @param {string} header
   */
  const headerLabel = (header) => t(EDIT_LABELS[/** @type {EditableHeader} */ (header)] ?? header);

  /** Bouton « Convertir en UTF-8 », placé sous l'avertissement d'encodage. */
  /**
   * Avertissement de nommage regroupé : détail de chaque nom, puis bouton de renommage.
   * @param {import('./api.js').SongWarning[]} warnings
   */
  function namingItem(warnings) {
    const item = el('li');
    item.append(
      icon(warningIcon('NAMING'), 'bi details-warning-icon'),
      el('span', '', t('details.namingTitle')),
    );
    const sub = el('ul', 'details-naming small text-body-secondary');
    for (const warning of warnings) {
      const key = `warnings.${warning.code}`;
      const text = t(key, warning.params);
      sub.append(el('li', 'text-break', text === key ? warning.message : text));
    }
    item.append(sub);
    if (canEdit() && renamer) {
      const action = /** @type {HTMLButtonElement} */ (
        el('button', 'btn btn-sm btn-outline-warning mb-2')
      );
      action.type = 'button';
      action.disabled = busy;
      action.append(icon('input-cursor-text', 'bi me-1'), t('rename.open'));
      action.addEventListener('click', openRename);
      item.append(action);
    }
    return item;
  }

  function convertButton() {
    const wrap = el('div', 'mt-1 mb-2');
    const action = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-sm btn-outline-warning')
    );
    action.type = 'button';
    action.disabled = busy;
    action.append(icon('arrow-repeat', 'bi me-1'), t('encoding.convert'));
    action.addEventListener('click', convertEncoding);
    wrap.append(action, el('small', 'd-block text-body-secondary mt-1', t('encoding.hint')));
    return wrap;
  }

  /** Convertit le fichier en UTF-8 sans BOM (sauvegarde datée côté serveur). */
  async function convertEncoding() {
    if (!current || busy) return;
    busy = true;
    renderBody();
    try {
      const { data } = await convertSongToUtf8(current.id, {
        expectedModifiedAt: current.modifiedAt,
      });
      current = data.song;
      onSongUpdated(data.song);
      message = {
        kind: 'success',
        text: t('encoding.converted', { from: data.from, backup: data.backup ?? '—' }),
      };
      const fresh = await getSongDetails(data.song.id);
      details = fresh.data.details;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderHeader();
    renderBody();
  }

  // --- Caractères mal encodés (« Ã© » au lieu de « é ») : aperçu puis réparation ------

  /** Bloc sous l'avertissement ENCODING_MOJIBAKE. */
  function repairBlock() {
    const wrap = el('div', 'mt-1 mb-2');
    /** @param {string} label @param {string} className @param {() => void} onClick @param {string} [iconName] */
    const action = (label, className, onClick, iconName) => {
      const node = /** @type {HTMLButtonElement} */ (el('button', `btn btn-sm ${className}`));
      node.type = 'button';
      node.disabled = busy;
      if (busy && iconName) node.append(el('span', 'spinner-border spinner-border-sm me-1'));
      else if (iconName) node.append(icon(iconName, 'bi me-1'));
      node.append(label);
      node.addEventListener('click', onClick);
      return node;
    };
    if (textRepair) {
      // Aperçu : chaque ligne modifiée, avant (rouge) / après (vert)
      const diff = el('div', 'rename-diff text-repair-diff mb-2');
      for (const change of textRepair) {
        diff.append(
          el('div', 'rename-diff-head small', t('textRepair.line', { line: change.line })),
          el('div', 'rename-diff-del', `- ${change.before}`),
          el('div', 'rename-diff-add', `+ ${change.after}`),
        );
      }
      wrap.append(
        el('small', 'd-block mb-1', t('textRepair.preview', { count: textRepair.length })),
        diff,
        action(t('textRepair.apply'), 'btn-warning me-2', applyTextRepair, 'check2'),
        action(t('video.cancel'), 'btn-outline-secondary', () => {
          textRepair = null;
          renderBody();
        }),
      );
      return wrap;
    }
    wrap.append(
      action(t('textRepair.show'), 'btn-outline-warning', previewTextRepair, 'magic'),
      el('small', 'd-block text-body-secondary mt-1', t('textRepair.hint')),
    );
    return wrap;
  }

  /** 1. Simulation : lignes qui seront corrigées (rien n'est écrit). */
  async function previewTextRepair() {
    if (!current || busy) return;
    busy = true;
    renderBody();
    try {
      const { data } = await repairSongText(current.id, {
        expectedModifiedAt: current.modifiedAt,
        dryRun: true,
      });
      textRepair = data.changes;
      message = null;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderBody();
  }

  /** 2. Réparation (sauvegarde datée côté serveur). */
  async function applyTextRepair() {
    if (!current || busy || !textRepair) return;
    busy = true;
    renderBody();
    try {
      const { data } = await repairSongText(current.id, {
        expectedModifiedAt: current.modifiedAt,
      });
      current = data.song;
      onSongUpdated(data.song);
      message = {
        kind: 'success',
        text: t('textRepair.done', { count: data.changes.length, backup: data.backup ?? '—' }),
      };
      textRepair = null;
      details = (await getSongDetails(data.song.id)).data.details;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderHeader();
    renderBody();
  }

  /**
   * Bouton « Renommer » à droite du titre « Fichiers » (niveau écriture) : toujours présent,
   * pour renommer à la main même des fichiers déjà conformes.
   */
  function renameButton() {
    if (!renamer || !canEdit()) return undefined;
    const action = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-sm btn-outline-primary details-heading-action')
    );
    action.type = 'button';
    action.disabled = busy;
    action.title = t('rename.title');
    action.append(icon('input-cursor-text', 'bi me-1'), t('rename.short'));
    action.addEventListener('click', openRename);
    return action;
  }

  /** Bouton « MusicBrainz » à droite du titre « Informations » (niveau écriture). */
  function musicBrainzButton() {
    if (!musicBrainz || !canEdit()) return undefined;
    const action = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-sm btn-outline-primary details-heading-action')
    );
    action.type = 'button';
    action.title = t('musicbrainz.intro');
    action.append(icon('search', 'bi me-1'), t('musicbrainz.title'));
    action.addEventListener('click', openMusicBrainz);
    return action;
  }

  // --- ReplayGain : mesure puis écriture dans le tag ID3 -------------------------------

  /** Bloc sous l'avertissement REPLAYGAIN_MISSING. */
  function replayGainBlock() {
    const wrap = el('div', 'mt-1 mb-2');
    if (!details?.ffmpeg) {
      wrap.append(el('small', 'd-block text-body-secondary', t('video.unavailable')));
      return wrap;
    }
    /** @param {string} label @param {string} className @param {() => void} onClick @param {string} [iconName] */
    const action = (label, className, onClick, iconName) => {
      const node = /** @type {HTMLButtonElement} */ (el('button', `btn btn-sm ${className}`));
      node.type = 'button';
      node.disabled = busy;
      if (busy && iconName) node.append(el('span', 'spinner-border spinner-border-sm me-1'));
      else if (iconName) node.append(icon(iconName, 'bi me-1'));
      node.append(label);
      node.addEventListener('click', onClick);
      return node;
    };
    if (gainMeasure) {
      wrap.append(
        el(
          'small',
          'd-block mb-1',
          t('replayGain.measured', {
            gain: `${gainMeasure.trackGain > 0 ? '+' : ''}${number(gainMeasure.trackGain)} dB`,
            peak: number(gainMeasure.trackPeak, 3),
          }),
        ),
        action(t('replayGain.write'), 'btn-warning me-2', writeReplayGain, 'check2'),
        action(t('video.cancel'), 'btn-outline-secondary', () => {
          gainMeasure = null;
          renderBody();
        }),
      );
      return wrap;
    }
    wrap.append(
      action(
        t(busy ? 'replayGain.measuring' : 'replayGain.measure'),
        'btn-outline-warning',
        measureReplayGain,
        'speedometer2',
      ),
      el('small', 'd-block text-body-secondary mt-1', t('replayGain.hint')),
    );
    return wrap;
  }

  /** 1. Mesure (ffmpeg décode le morceau : quelques secondes). */
  async function measureReplayGain() {
    if (!current || busy) return;
    busy = true;
    renderBody();
    try {
      gainMeasure = (await songReplayGain(current.id, { dryRun: true })).data;
      message = null;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderBody();
  }

  /** 2. Écriture dans le tag ID3 du MP3. */
  async function writeReplayGain() {
    if (!current || busy || !gainMeasure) return;
    busy = true;
    renderBody();
    try {
      const { data } = await songReplayGain(current.id, {
        trackGain: gainMeasure.trackGain,
        trackPeak: gainMeasure.trackPeak,
        expectedAudioModifiedAt: gainMeasure.audioModifiedAt,
      });
      current = data.song;
      onSongUpdated(data.song);
      message = {
        kind: 'success',
        text: data.backup
          ? t('replayGain.written', { backup: data.backup })
          : t('replayGain.writtenNoBackup'),
      };
      gainMeasure = null;
      details = (await getSongDetails(data.song.id)).data.details;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderHeader();
    renderBody();
  }

  // --- Création du MP3 (vidéo qui sert aussi de musique) -----------------------------

  /** Bloc sous l'avertissement VIDEO_IS_AUDIO : bouton, puis confirmation. */
  function audioBlock() {
    const wrap = el('div', 'mt-1 mb-2');
    if (!details?.video?.canExtractAudio) {
      wrap.append(el('small', 'd-block text-body-secondary', t('video.unavailable')));
      return wrap;
    }
    if (audioPlan) {
      wrap.append(
        el(
          'small',
          'd-block mb-1',
          t(audioPlan.reuse ? 'audio.planReuse' : 'audio.plan', {
            from: audioPlan.from,
            to: audioPlan.to,
          }),
        ),
      );
      const start = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-sm btn-warning me-2'));
      start.type = 'button';
      start.disabled = busy;
      start.append(
        busy ? el('span', 'spinner-border spinner-border-sm me-1') : icon('check2', 'bi me-1'),
        t('audio.start'),
      );
      start.addEventListener('click', extractAudio);
      const cancel = /** @type {HTMLButtonElement} */ (
        el('button', 'btn btn-sm btn-outline-secondary')
      );
      cancel.type = 'button';
      cancel.disabled = busy;
      cancel.textContent = t('video.cancel');
      cancel.addEventListener('click', () => {
        audioPlan = null;
        renderBody();
      });
      wrap.append(start, cancel);
      return wrap;
    }
    const action = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-sm btn-outline-warning')
    );
    action.type = 'button';
    action.disabled = busy || videoJob?.state === 'running';
    action.append(icon('file-earmark-music', 'bi me-1'), t('audio.create'));
    action.addEventListener('click', proposeAudioExtraction);
    wrap.append(action, el('small', 'd-block text-body-secondary mt-1', t('audio.hint')));
    return wrap;
  }

  /** 1. Simulation : nom du MP3 qui sera créé. */
  async function proposeAudioExtraction() {
    if (!current || busy) return;
    busy = true;
    renderBody();
    try {
      const { data } = await extractSongAudio(current.id, {
        expectedModifiedAt: current.modifiedAt,
        dryRun: true,
      });
      audioPlan = data.plan;
      message = null;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderBody();
  }

  /** 2. Création du MP3 et mise à jour de #AUDIO / #MP3. */
  async function extractAudio() {
    if (!current || busy || !audioPlan) return;
    busy = true;
    renderBody();
    try {
      const { data } = await extractSongAudio(current.id, {
        expectedModifiedAt: current.modifiedAt,
      });
      current = data.song;
      onSongUpdated(data.song);
      message = {
        kind: 'success',
        text: t(data.plan.reuse ? 'audio.doneReuse' : 'audio.done', {
          file: data.plan.to,
          headers: data.headers.map((h) => `#${h}`).join(', '),
          backup: data.backup ?? '—',
        }),
      };
      audioPlan = null;
      details = (await getSongDetails(data.song.id)).data.details;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderHeader();
    renderBody();
  }

  // --- Conversion vidéo ----------------------------------------------------------------

  /** Conversion de la chanson affichée, en cours ? */
  const videoRunning = () => videoJob?.state === 'running' && videoJob.songId === current?.id;

  /** Texte de progression (« Conversion… 42 % »). */
  function videoProgressText() {
    const progress = videoJob?.progress;
    return progress === null || progress === undefined
      ? t('video.runningUnknown')
      : t('video.running', { percent: Math.round(progress * 100) });
  }

  /** Bloc sous l'avertissement vidéo : bouton, confirmation ou progression. */
  function videoBlock() {
    const wrap = el('div', 'mt-1 mb-2');
    if (videoRunning()) {
      const bar = /** @type {HTMLProgressElement} */ (el('progress', 'details-video-progress'));
      bar.max = 1;
      if (videoJob?.progress !== null && videoJob?.progress !== undefined)
        bar.value = videoJob.progress;
      bar.dataset.videoProgress = '';
      const text = el('small', 'd-block text-body-secondary', videoProgressText());
      text.dataset.videoProgressText = '';
      wrap.append(bar, text);
      return wrap;
    }
    if (details?.video?.isAudio) {
      wrap.append(el('small', 'd-block text-body-secondary', t('video.isAudio')));
      return wrap;
    }
    if (!details?.video?.canConvert) {
      wrap.append(el('small', 'd-block text-body-secondary', t('video.unavailable')));
      return wrap;
    }
    if (videoPlan) {
      const plan = videoPlan;
      wrap.append(
        el(
          'small',
          'd-block mb-1',
          // Original sauvegardé ou supprimé, selon les préférences
          t(
            `video.${plan.replaces ? 'planReplace' : 'planNew'}${plan.keepOriginal ? '' : 'NoBackup'}`,
            {
              from: plan.from,
              to: plan.to,
            },
          ),
        ),
        el('small', 'd-block text-body-secondary mb-1', t('video.duration')),
      );
      const start = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-sm btn-warning me-2'));
      start.type = 'button';
      start.disabled = busy;
      start.append(icon('check2', 'bi me-1'), t('video.start'));
      start.addEventListener('click', startVideoConversion);
      const cancel = /** @type {HTMLButtonElement} */ (
        el('button', 'btn btn-sm btn-outline-secondary')
      );
      cancel.type = 'button';
      cancel.textContent = t('video.cancel');
      cancel.addEventListener('click', () => {
        videoPlan = null;
        renderBody();
      });
      wrap.append(start, cancel);
      return wrap;
    }
    const action = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-sm btn-outline-warning')
    );
    action.type = 'button';
    action.disabled = busy || videoJob?.state === 'running';
    action.append(icon('film', 'bi me-1'), t('video.convert'));
    action.addEventListener('click', proposeVideoConversion);
    wrap.append(action, el('small', 'd-block text-body-secondary mt-1', t('video.hint')));
    return wrap;
  }

  /** 1. Simulation : le serveur dit ce qu'il va faire, on demande confirmation. */
  async function proposeVideoConversion() {
    if (!current || busy) return;
    busy = true;
    renderBody();
    try {
      const { data } = await convertSongVideo(current.id, {
        expectedModifiedAt: current.modifiedAt,
        dryRun: true,
      });
      videoPlan = data.plan;
      message = null;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderBody();
  }

  /** 2. Lancement, puis suivi jusqu'à la fin. */
  async function startVideoConversion() {
    if (!current || busy) return;
    busy = true;
    renderBody();
    try {
      const { data } = await convertSongVideo(current.id, {
        expectedModifiedAt: current.modifiedAt,
      });
      videoJob = data.job;
      videoPlan = null;
      message = null;
      pollVideoJob();
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderBody();
  }

  /** Relit l'état de la conversion ; continue même fenêtre fermée pour mettre la grille à jour. */
  function pollVideoJob() {
    clearTimeout(videoTimer);
    videoTimer = setTimeout(async () => {
      const job = videoJob;
      if (!job) return;
      try {
        const { data } = await getVideoJob(job.songId);
        videoJob = data.job;
      } catch (error) {
        console.error(error);
      }
      if (videoJob?.state === 'running') {
        updateVideoProgress();
        pollVideoJob();
      } else {
        await videoJobFinished();
      }
    }, VIDEO_POLL_MS);
  }

  /** Met à jour seulement la barre (pas de re-rendu : une saisie en cours est préservée). */
  function updateVideoProgress() {
    if (!videoRunning()) return;
    const bar = /** @type {HTMLProgressElement | null} */ (
      body.querySelector('[data-video-progress]')
    );
    const text = body.querySelector('[data-video-progress-text]');
    if (bar && videoJob?.progress !== null && videoJob?.progress !== undefined)
      bar.value = videoJob.progress;
    if (text) text.textContent = videoProgressText();
  }

  async function videoJobFinished() {
    const job = videoJob;
    if (!job) return;
    const shown = current?.id === job.songId;
    if (job.state === 'done') {
      try {
        const { data } = await getSongDetails(job.songId);
        onSongUpdated(data.song); // grille : plus d'avertissement, nouvelle vidéo
        if (current?.id === job.songId) {
          current = data.song;
          details = data.details;
        }
      } catch (error) {
        console.error(error);
      }
    }
    if (!shown) return;
    message =
      job.state === 'done'
        ? {
            kind: 'success',
            text: job.backup
              ? t('video.done', { file: job.to, backup: job.backup })
              : t('video.doneNoBackup', { file: job.to }),
          }
        : {
            kind: 'danger',
            text: errorText(
              new ApiError(job.code ?? 'VIDEO_CONVERSION_FAILED', '', 500, { file: job.to }),
            ),
          };
    renderHeader();
    renderBody();
  }

  /**
   * Traduit une erreur d'API en message.
   * @param {unknown} error
   */
  function errorText(error) {
    if (!(error instanceof ApiError)) return t('errors.INTERNAL_ERROR');
    const key = `errors.${error.code}`;
    const text = t(key, error.params);
    return text === key ? error.message : text;
  }

  /**
   * Valeurs actuelles d'un en-tête modifiable.
   * @param {Song} song
   * @param {EditableHeader} header
   * @returns {string[]}
   */
  function valuesOf(song, header) {
    /** @param {string | null | undefined} value */
    const one = (value) => (value ? [value] : []);
    if (TIMING_FIELDS.has(header)) return one(details?.headers[header]);
    switch (header) {
      case 'ARTIST':
        return one(song.artist);
      case 'TITLE':
        return one(song.title);
      case 'EDITION':
        return song.editions;
      case 'TAGS':
        return song.tags;
      case 'LANGUAGE':
        return song.languages;
      case 'GENRE':
        return song.genres;
      case 'YEAR':
        return one(song.year === null ? null : String(song.year));
      case 'P1':
        return one(details?.singers.p1);
      case 'P2':
        return one(details?.singers.p2);
      default:
        return song.creators;
    }
  }

  /**
   * Passe un champ en modification (double-clic ou crayon).
   * @param {EditableHeader} header
   */
  function startEdit(header) {
    if (busy || !current) return;
    editing = header;
    pendingValues = null;
    message = null;
    renderBody();
  }

  function cancelEdit() {
    editing = null;
    pendingValues = null;
    renderBody();
  }

  /**
   * Valeur d'une ligne modifiable : double-clic ou crayon pour la modifier sur place.
   * @param {EditableHeader} header
   * @param {Node | string} display  Affichage normal (pastilles).
   * @returns {Node | string}
   */
  function editableValue(header, display) {
    if (!canEdit()) return display;
    const wrap = el('div', 'details-editable');
    if (editing === header) {
      renderInlineEditor(wrap, header);
      return wrap;
    }
    wrap.title = t('edit.dblclickHint');
    const value = el('div', 'details-editable-value');
    value.append(display);
    const pencil = /** @type {HTMLButtonElement} */ (el('button', 'details-edit-btn'));
    pencil.type = 'button';
    pencil.setAttribute('aria-label', t('edit.editField', { field: headerLabel(header) }));
    pencil.append(icon('pencil-square'));
    pencil.addEventListener('click', () => startEdit(header));
    wrap.addEventListener('dblclick', (event) => {
      event.preventDefault();
      window.getSelection()?.removeAllRanges(); // le double-clic sélectionne un mot : on l'annule
      startEdit(header);
    });
    wrap.append(value, pencil);
    return wrap;
  }

  /**
   * Champ à pastilles en place, avec ✓ (enregistrer) et ✕ (annuler).
   * Entrée dans une saisie vide = enregistrer ; Échap = annuler.
   * @param {HTMLElement} wrap
   * @param {EditableHeader} header
   */
  function renderInlineEditor(wrap, header) {
    if (!current) return;
    wrap.classList.add('is-editing');
    const field = el('div', 'details-inline-field');
    const input = SINGLE_VALUE_FIELDS.has(header)
      ? createSingleInput(field, header)
      : createChipsInput(field, {
          values: pendingValues ?? valuesOf(current, header),
          suggestions: getSuggestions(header),
          label: headerLabel(header),
          onEnterEmpty: () => saveEdit(header, input.getValues()),
          onEscape: cancelEdit,
        });
    const actions = el('div', 'details-inline-actions');
    const save = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-sm btn-success'));
    save.type = 'button';
    save.disabled = busy;
    save.title = t('edit.save');
    save.setAttribute('aria-label', t('edit.save'));
    save.append(icon('check2'));
    save.addEventListener('click', () => saveEdit(header, input.getValues()));
    const cancel = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-sm btn-outline-secondary')
    );
    cancel.type = 'button';
    cancel.disabled = busy;
    cancel.title = t('edit.cancel');
    cancel.setAttribute('aria-label', t('edit.cancel'));
    cancel.append(icon('x-lg'));
    cancel.addEventListener('click', cancelEdit);
    actions.append(save, cancel);
    if (IDENTITY_FIELDS.has(header)) {
      // Prévenir : autres .txt du dossier, playlists et scores UltraStar
      field.append(el('small', 'details-inline-hint text-body-secondary', t('edit.identityHint')));
    } else if (TIMING_FIELDS.has(header)) {
      // Unité, valeur vide, effet sur la chanson
      field.append(
        el('small', 'details-inline-hint text-body-secondary', t(`timingHelp.${header}`)),
      );
    }
    wrap.append(field, actions);
    queueMicrotask(() => input.focus());
  }

  /**
   * Saisie simple (année, nom d'un chanteur) : Entrée = enregistrer, Échap = annuler.
   * Même interface que les pastilles (getValues, focus).
   * @param {HTMLElement} field
   * @param {EditableHeader} header
   */
  function createSingleInput(field, header) {
    const input = /** @type {HTMLInputElement} */ (el('input', 'form-control form-control-sm'));
    input.type = 'text';
    input.value = (pendingValues ?? valuesOf(/** @type {Song} */ (current), header))[0] ?? '';
    input.setAttribute('aria-label', headerLabel(header));
    if (header === 'YEAR') {
      input.inputMode = 'numeric';
      input.maxLength = 4;
      input.pattern = '\\d{4}';
      input.placeholder = t('edit.yearPlaceholder');
    }
    if (TIMING_FIELDS.has(header)) {
      input.inputMode = 'decimal';
      input.maxLength = 20;
      input.placeholder = t(`timingHint.${header}`);
    }
    const getValues = () => (input.value.trim() ? [input.value.trim()] : []);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveEdit(header, getValues());
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      }
    });
    field.append(input);
    return {
      getValues,
      focus: () => {
        input.focus();
        input.select();
      },
    };
  }

  /**
   * Enregistre un champ : sauvegarde datée + écriture côté serveur, puis réaffichage.
   * @param {EditableHeader} header
   * @param {string[]} values
   */
  async function saveEdit(header, values) {
    if (!current || busy) return;
    const before = valuesOf(current, header).join(', ');
    const after = values.join(', ');
    if (before === after) {
      cancelEdit();
      return;
    }
    busy = true;
    pendingValues = values;
    renderBody();
    try {
      const { data } = await updateSongHeaders(current.id, {
        values: { [header]: after || null },
        expectedModifiedAt: current.modifiedAt,
      });
      current = data.song;
      onSongUpdated(data.song);
      const change = data.changes[0];
      message = change
        ? {
            kind: 'success',
            text: [
              t('edit.savedField', {
                field: headerLabel(header),
                before: change.before ?? t('edit.empty'),
                after: change.after ?? t('edit.empty'),
                backup: data.backup ?? '—',
              }),
              propagationText(data),
            ]
              .filter(Boolean)
              .join(' '),
          }
        : null;
      editing = null;
      pendingValues = null;
      const fresh = await getSongDetails(data.song.id);
      details = fresh.data.details;
    } catch (error) {
      message = { kind: 'danger', text: errorText(error) };
    } finally {
      busy = false;
    }
    renderHeader();
    renderBody();
  }

  /**
   * « Piste −10,27 dB · crête 1,208 · Album … » (tags ReplayGain du fichier audio).
   * @param {import('./api.js').ReplayGain | null | undefined} gain
   * @returns {Node | string}
   */
  function replayGainText(gain) {
    if (!gain) return el('span', 'text-body-secondary', t('details.replayGainNone'));
    /** @param {number | null} value */
    const db = (value) => (value === null ? null : `${value > 0 ? '+' : ''}${number(value)} dB`);
    /** @param {number | null} gainValue @param {number | null} peak @param {string} label */
    const part = (gainValue, peak, label) =>
      gainValue === null && peak === null
        ? null
        : [
            `${label} ${db(gainValue) ?? '—'}`,
            peak === null ? null : t('details.replayGainPeak', { value: number(peak, 3) }),
          ]
            .filter(Boolean)
            .join(' · ');
    const text = [
      part(gain.trackGain, gain.trackPeak, t('details.replayGainTrack')),
      part(gain.albumGain, gain.albumPeak, t('details.replayGainAlbum')),
    ]
      .filter(Boolean)
      .join(' — ');
    const wrap = el('span', '', text);
    wrap.append(
      el('small', 'text-body-secondary', ` (${gain.source === 'ape' ? 'APEv2' : 'ID3'})`),
    );
    return wrap;
  }

  /**
   * Lignes « Format vidéo » et « Résolution » de la section Fichiers.
   * @param {import('./api.js').VideoDetails | null | undefined} video
   * @returns {[string, string, Node | string][]}
   */
  function videoRows(video) {
    if (!video) return [];
    const format = el('span', '', videoFormat(video));
    if (video.recommended) {
      format.append(' ', icon('check-circle-fill', 'bi text-success'));
      format.append(el('small', 'text-body-secondary', ` (${t('details.recommended')})`));
    }
    const size = el(
      'span',
      '',
      video.width && video.height
        ? `${video.width} × ${video.height}${video.frameRate ? ` · ${t('details.fps', { value: number(video.frameRate) })}` : ''}`
        : '—',
    );
    if (video.oversized) {
      size.append(' ', icon('exclamation-triangle-fill', 'bi text-warning'));
      size.append(el('small', 'text-body-secondary', ` (${t('details.oversized')})`));
    }
    return [
      ['badge-hd', t('details.videoFormat'), format],
      ['aspect-ratio', t('details.resolution'), size],
    ];
  }

  function renderBody() {
    if (!current) return;
    const song = current;
    if (!details) {
      body.replaceChildren(el('p', 'text-body-secondary', t('details.loading')));
      return;
    }
    const { headers, timing, stats, singers } = details;
    /** @type {Record<string, string>} */
    const previewSources = {
      tag: t('details.previewFromTag'),
      medley: t('details.previewFromMedley'),
    };

    /** @type {HTMLElement[]} */
    const sections = [];

    /** @type {[string, string, Node | string][]} */
    const infoRows = [
      ['person-fill', t('details.artist'), editableValue('ARTIST', song.artist ?? '—')],
      ['fonts', t('details.songTitle'), editableValue('TITLE', song.title ?? '—')],
      [
        'globe2',
        t('filters.language'),
        editableValue('LANGUAGE', chips('language', song.languages)),
      ],
      [
        'collection',
        t('filters.edition'),
        editableValue('EDITION', chips('edition', song.editions)),
      ],
      ['music-note-beamed', t('filters.genre'), editableValue('GENRE', chips(null, song.genres))],
      ['tags', t('filters.tag'), editableValue('TAGS', chips('tag', song.tags))],
      ['calendar3', t('details.year'), editableValue('YEAR', song.year ? String(song.year) : '—')],
      ['pencil-square', t('details.creator'), editableValue('CREATOR', chips(null, song.creators))],
    ];
    if (song.isDuet) {
      infoRows.push(
        ['person-fill', t('details.singer1'), editableValue('P1', singers.p1 ?? '—')],
        ['person-fill', t('details.singer2'), editableValue('P2', singers.p2 ?? '—')],
      );
    }
    sections.push(section('info-lg', t('details.information'), infoRows, musicBrainzButton()));

    /** @type {[string, string, Node | string][]} */
    /** Beat du medley : « 0:42 (beat 395) ». @param {number | null} seconds @param {string} header */
    const medleyBeat = (seconds, header) =>
      headers[header]
        ? `${seconds === null ? '' : `${formatTime(seconds)} `}(beat ${headers[header]})`
        : '—';
    const timingRows = [
      ['speedometer2', 'BPM', editableValue('BPM', number(timing.bpm))],
      [
        'hourglass-split',
        'GAP',
        editableValue('GAP', timing.gap === null ? '—' : `${number(timing.gap, 0)} ms`),
      ],
      [
        'film',
        'VIDEOGAP',
        editableValue('VIDEOGAP', timing.videoGap === null ? '—' : `${number(timing.videoGap)} s`),
      ],
      [
        'play-circle',
        t('details.preview'),
        editableValue(
          'PREVIEWSTART',
          timing.previewStart === null
            ? t('details.previewAuto')
            : `${time(timing.previewStart)} — ${previewSources[timing.previewSource ?? ''] ?? ''}`,
        ),
      ],
      [
        'skip-forward',
        t('timing.medleyStartShort'),
        editableValue('MEDLEYSTARTBEAT', medleyBeat(timing.medleyStart, 'MEDLEYSTARTBEAT')),
      ],
      [
        'skip-end',
        t('timing.medleyEndShort'),
        editableValue('MEDLEYENDBEAT', medleyBeat(timing.medleyEnd, 'MEDLEYENDBEAT')),
      ],
    ];
    if (timing.start !== null) {
      timingRows.push(['stopwatch', 'START', editableValue('START', time(timing.start))]);
    }
    if (timing.end !== null) {
      timingRows.push(['stopwatch', 'END', editableValue('END', time(timing.end / 1000))]);
    }
    sections.push(section('stopwatch', t('details.timing'), timingRows));

    const videoNote =
      song.files.video && !videoMimeType(song.files.video)
        ? t('details.videoNotPlayable')
        : undefined;
    sections.push(
      section(
        'folder2-open',
        t('details.files'),
        [
          ['folder2-open', t('details.folder'), song.folder || '.'],
          [
            'file-earmark-text',
            t('details.txtFile'),
            `${song.txtFile} · ${details.encoding}${headers.VERSION ? ` · v${headers.VERSION}` : ''}`,
          ],
          [
            'file-earmark-music',
            t('details.audio'),
            fileState(song.files.audio, headers.AUDIO ?? headers.MP3),
          ],
          ...(song.files.audio
            ? /** @type {[string, string, Node | string][]} */ ([
                ['speedometer2', 'ReplayGain', replayGainText(details.replayGain)],
              ])
            : []),
          ['film', t('details.video'), fileState(song.files.video, headers.VIDEO, videoNote)],
          ...videoRows(details.video),
          [
            'image',
            t('details.cover'),
            fileState(
              song.files.cover,
              headers.COVER,
              song.coverGuessed ? t('details.coverGuessed') : undefined,
            ),
          ],
          [
            'card-image',
            t('details.background'),
            fileState(song.files.background, headers.BACKGROUND),
          ],
        ],
        renameButton(),
      ),
    );

    sections.push(
      section('music-note-list', t('details.stats'), [
        ['music-note-list', t('details.notes'), number(stats.notes, 0)],
        ['list-ul', t('details.phrases'), number(stats.lineBreaks + 1, 0)],
      ]),
    );

    if (song.warnings.length > 0) {
      const block = el('section', 'details-section');
      const h = el('h3', 'details-heading text-warning');
      h.append(icon('exclamation-triangle-fill'), el('span', '', t('details.warnings')));
      const list = el('ul', 'details-warnings');
      // Le bloc de conversion vidéo va sous le premier avertissement vidéo (format ou taille).
      const videoWarning = song.warnings.find((w) => VIDEO_WARNINGS.has(w.code));
      // Nommage : un seul avertissement regroupant dossier, .txt, médias…
      const naming = song.warnings.filter((w) => w.code.startsWith('NAMING_'));
      for (const warning of song.warnings) {
        if (warning === naming[0]) {
          list.append(namingItem(naming));
          continue;
        }
        if (naming.includes(warning)) continue;
        const key = `warnings.${warning.code}`;
        const text = t(key, warning.params);
        const item = el('li');
        // Icône du type, la même que dans le filtre « Avertissements »
        item.append(
          icon(warningIcon(warningType(warning)), 'bi details-warning-icon'),
          el('span', '', text === key ? warning.message : text),
        );
        if (ENCODING_WARNINGS.has(warning.code) && canEdit()) item.append(convertButton());
        if (warning.code === 'ENCODING_MOJIBAKE' && canEdit()) item.append(repairBlock());
        if (warning === videoWarning && canEdit()) item.append(videoBlock());
        if (warning.code === 'VIDEO_IS_AUDIO' && canEdit()) item.append(audioBlock());
        if (warning.code === 'REPLAYGAIN_MISSING' && canEdit()) item.append(replayGainBlock());
        list.append(item);
      }
      block.append(h, list);
      sections.push(block);
    }

    const others = Object.entries(headers).filter(([key]) => !SHOWN_HEADERS.has(key));
    if (others.length > 0) {
      const more = /** @type {HTMLDetailsElement} */ (
        el('details', 'details-section details-more')
      );
      const summary = el('summary', 'details-heading');
      summary.append(
        icon('list-ul'),
        el('span', '', t('details.otherHeaders', { count: others.length })),
      );
      const list = el('dl', 'details-list');
      for (const [key, value] of others) {
        const row = el('div', 'details-row');
        row.append(el('dt', 'font-monospace', `#${key}`), el('dd', '', value));
        list.append(row);
      }
      more.append(summary, list);
      sections.push(more);
    }

    const notice = messageBlock();
    // Panneau MusicBrainz juste après « Informations » (les champs qu'il complète).
    body.replaceChildren(...(notice ? [notice] : []), ...sections);
    // Nouveau message (réussite ou erreur d'une action) : on le montre, même si l'utilisateur
    // était en bas de la fenêtre, sur l'avertissement qu'il corrigeait.
    if (notice && message !== shownMessage) notice.scrollIntoView({ block: 'nearest' });
    shownMessage = message;
    // Le bouton cliqué a pu disparaître avec le re-rendu : on garde le focus dans la fenêtre,
    // sinon Échap ne la fermerait plus.
    if (modal.classList.contains('show') && !modal.contains(document.activeElement)) modal.focus();
  }

  /**
   * Ouvre la fenêtre pour une chanson (le détail arrive ensuite du serveur).
   * @param {Song} song
   * @param {{ kind: 'success' | 'danger' | 'info', text: string } | null} [notice]  Message à afficher.
   */
  async function openDetails(song, notice = null) {
    const id = ++request;
    current = song;
    details = null;
    editing = null;
    pendingValues = null;
    message = notice;
    videoPlan = null;
    audioPlan = null;
    gainMeasure = null;
    textRepair = null;
    renderHeader();
    renderBody();
    bootstrapModal.show();
    try {
      const { data } = await getSongDetails(song.id);
      if (id !== request) return;
      current = data.song;
      details = data.details;
      // Conversion vidéo lancée avant (fenêtre fermée, page rechargée) : on reprend le suivi.
      if (
        canEdit() &&
        data.song.warnings.some((w) => VIDEO_WARNINGS.has(w.code)) &&
        !videoRunning()
      ) {
        const { data: jobData } = await getVideoJob(song.id);
        if (id !== request) return;
        if (jobData.job?.state === 'running') {
          videoJob = jobData.job;
          pollVideoJob();
        }
      }
    } catch (error) {
      console.error(error);
      if (id !== request) return;
      body.replaceChildren(el('p', 'text-danger', t('details.error')));
      return;
    }
    renderHeader();
    renderBody();
  }

  return {
    /**
     * Ouvre la fenêtre pour une chanson.
     * @param {Song} song
     */
    open: (song) => openDetails(song),

    /** Retraduit la fenêtre ouverte après un changement de langue. */
    refresh() {
      musicBrainz?.refresh();
      renamer?.refresh();
      renderHeader();
      renderBody();
    },
  };
}
