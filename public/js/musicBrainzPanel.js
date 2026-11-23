// @ts-check
/**
 * Fenêtre « MusicBrainz », ouverte par le bouton à côté du titre « Informations » de la
 * fenêtre info (niveau écriture). Elle remplace un moment la fenêtre info (Bootstrap
 * n'empile pas les fenêtres), qui se rouvre à la fermeture.
 *
 * 1. Recherche par artiste et titre dès l'ouverture → liste des enregistrements trouvés ;
 * 2. l'utilisateur choisit le bon → année, langues et genres proposés, à côté des valeurs
 *    actuelles ;
 * 3. il coche ce qui lui convient → seules ces valeurs remplacent #YEAR, #LANGUAGE, #GENRE
 *    (PATCH /headers : sauvegarde datée, encodage conservé).
 *
 * @module musicBrainzPanel
 */
import { ApiError, getMusicBrainzSuggestion, searchMusicBrainz, updateSongHeaders } from './api.js';
import { t } from './i18n.js';

/** @typedef {import('./api.js').Song} Song */
/** @typedef {import('./api.js').MbCandidate} MbCandidate */
/** @typedef {import('./api.js').MbSuggestion} MbSuggestion */
/** @typedef {'searching' | 'candidates' | 'loading' | 'suggestion' | 'saving' | 'failed'} Phase */

const ICONS = '/img/vendor/bootstrap-icons/icons.svg';

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

/** @param {string} name */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'bi me-1');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

/**
 * @param {string} label
 * @param {string} className
 * @param {() => void} onClick
 * @param {string} [iconName]
 */
function button(label, className, onClick, iconName) {
  const node = /** @type {HTMLButtonElement} */ (el('button', `btn btn-sm ${className}`));
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  node.append(label);
  node.addEventListener('click', onClick);
  return node;
}

/** @param {unknown} error */
function errorText(error) {
  if (!(error instanceof ApiError)) return t('errors.NETWORK_ERROR');
  const key = `errors.${error.code}`;
  const text = t(key, error.params);
  return text === key ? error.message : text;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.modal  Fenêtre #musicbrainz-modal (.modal Bootstrap).
 * @param {(song: Song, applied: { backup: string | null } | null) => void} options.onClosed
 *   À la fermeture : la chanson (à jour si des valeurs ont été appliquées) et le résultat.
 */
export function createMusicBrainzDialog({ modal, onClosed }) {
  const body = /** @type {HTMLElement} */ (modal.querySelector('.modal-body'));
  const subtitle = /** @type {HTMLElement} */ (modal.querySelector('.mb-subtitle'));
  const bootstrapModal = /** @type {any} */ (globalThis).bootstrap.Modal.getOrCreateInstance(modal);

  /**
   * @type {{
   *   phase: Phase,
   *   song: Song | null,
   *   candidates: MbCandidate[],
   *   chosen: MbCandidate | null,
   *   suggestion: MbSuggestion | null,
   *   pick: { year: boolean, languages: Set<string>, genres: Set<string> },
   *   error: string | null,
   *   applied: { backup: string | null } | null,
   * }}
   */
  const state = {
    phase: 'searching',
    song: null,
    candidates: [],
    chosen: null,
    suggestion: null,
    pick: { year: false, languages: new Set(), genres: new Set() },
    error: null,
    applied: null,
  };

  modal.addEventListener('hidden.bs.modal', () => {
    if (state.song) onClosed(state.song, state.applied);
  });

  const close = () => bootstrapModal.hide();

  async function search() {
    const song = state.song;
    if (!song) return;
    Object.assign(state, { phase: 'searching', error: null, candidates: [] });
    render();
    try {
      const { data } = await searchMusicBrainz(song.id);
      if (state.song !== song) return;
      Object.assign(state, { phase: 'candidates', candidates: data.candidates });
    } catch (error) {
      Object.assign(state, { phase: 'failed', error: errorText(error) });
    }
    render();
  }

  /** @param {MbCandidate} candidate */
  async function choose(candidate) {
    const song = state.song;
    if (!song) return;
    Object.assign(state, { phase: 'loading', chosen: candidate, error: null });
    render();
    try {
      const { data } = await getMusicBrainzSuggestion(song.id, candidate);
      if (state.song !== song) return;
      const suggestion = data.suggestion;
      // Coché d'office seulement ce qui manque dans la chanson.
      const firstLanguage = suggestion.languages[0]?.name;
      const firstGenre = suggestion.genres[0];
      state.pick = {
        year: song.year === null && suggestion.year !== null,
        languages: new Set(song.languages.length === 0 && firstLanguage ? [firstLanguage] : []),
        genres: new Set(song.genres.length === 0 && firstGenre ? [firstGenre] : []),
      };
      Object.assign(state, { phase: 'suggestion', suggestion });
    } catch (error) {
      Object.assign(state, { phase: 'candidates', error: errorText(error) });
    }
    render();
  }

  /** Valeurs cochées, au format des en-têtes. */
  function pickedValues() {
    const { suggestion, pick } = state;
    /** @type {Record<string, string>} */
    const values = {};
    if (!suggestion) return values;
    if (pick.year && suggestion.year !== null) values.YEAR = String(suggestion.year);
    const languages = suggestion.languages.map((l) => l.name).filter((n) => pick.languages.has(n));
    if (languages.length > 0) values.LANGUAGE = languages.join(', ');
    const genres = suggestion.genres.filter((g) => pick.genres.has(g));
    if (genres.length > 0) values.GENRE = genres.join(', ');
    return values;
  }

  async function apply() {
    const song = state.song;
    const values = pickedValues();
    if (!song || Object.keys(values).length === 0) return;
    state.phase = 'saving';
    render();
    try {
      const { data } = await updateSongHeaders(song.id, {
        values,
        expectedModifiedAt: song.modifiedAt,
      });
      state.song = data.song;
      state.applied = { backup: data.backup };
      close(); // la fenêtre info se rouvre avec le message de réussite
    } catch (error) {
      Object.assign(state, { phase: 'suggestion', error: errorText(error) });
      render();
    }
  }

  /**
   * Case à cocher avec son libellé.
   * @param {string} label
   * @param {boolean} checked
   * @param {(checked: boolean) => void} onChange
   */
  function checkbox(label, checked, onChange) {
    const wrap = el('label', 'form-check form-check-inline mb-0');
    const input = /** @type {HTMLInputElement} */ (el('input', 'form-check-input'));
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = state.phase === 'saving';
    input.addEventListener('change', () => {
      onChange(input.checked);
      render();
    });
    wrap.append(input, el('span', 'form-check-label', label));
    return wrap;
  }

  /**
   * Ligne « champ : valeur actuelle → propositions ».
   * @param {string} label
   * @param {string} currentValue
   * @param {Node[]} proposals
   */
  function row(label, currentValue, proposals) {
    const tr = el('tr');
    const th = el('th', 'fw-semibold', label);
    th.setAttribute('scope', 'row');
    const now = el('td', 'text-body-secondary', currentValue || '—');
    const next = el('td');
    if (proposals.length === 0) {
      next.append(el('span', 'text-body-secondary', t('musicbrainz.nothing')));
    } else {
      next.append(...proposals);
    }
    tr.append(th, now, next);
    return tr;
  }

  /** @returns {Node[]} */
  function renderSuggestion() {
    const { song, suggestion, chosen, pick } = state;
    if (!song || !suggestion || !chosen) return [];
    const source = el('p', 'small mb-2');
    const link = /** @type {HTMLAnchorElement} */ (
      el('a', '', `${chosen.artist} – ${chosen.title}`)
    );
    link.href = `https://musicbrainz.org/recording/${encodeURIComponent(chosen.id)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(' ', icon('box-arrow-up-right'));
    source.append(t('musicbrainz.source'), ' ', link);

    const table = el('table', 'table table-sm align-middle mb-2 mb-table');
    const head = el('thead');
    const headRow = el('tr');
    for (const text of ['', t('musicbrainz.current'), t('musicbrainz.proposed')]) {
      const th = el('th', 'small text-body-secondary fw-normal', text);
      th.setAttribute('scope', 'col');
      headRow.append(th);
    }
    head.append(headRow);
    const rows = el('tbody');
    rows.append(
      row(
        t('details.year'),
        song.year ? String(song.year) : '',
        suggestion.year === null
          ? []
          : [
              checkbox(String(suggestion.year), pick.year, (on) => {
                pick.year = on;
              }),
            ],
      ),
      row(
        t('filters.language'),
        song.languages.join(', '),
        suggestion.languages.map((l) =>
          checkbox(l.name, pick.languages.has(l.name), (on) => {
            if (on) pick.languages.add(l.name);
            else pick.languages.delete(l.name);
          }),
        ),
      ),
      row(
        t('filters.genre'),
        song.genres.join(', '),
        suggestion.genres.map((g) =>
          checkbox(g, pick.genres.has(g), (on) => {
            if (on) pick.genres.add(g);
            else pick.genres.delete(g);
          }),
        ),
      ),
    );
    table.append(head, rows);

    const count = Object.keys(pickedValues()).length;
    const actions = el('div', 'd-flex flex-wrap gap-2');
    const applyButton = button(t('musicbrainz.apply', { count }), 'btn-primary', apply, 'check2');
    applyButton.disabled = count === 0 || state.phase === 'saving';
    actions.append(
      applyButton,
      button(t('musicbrainz.otherResult'), 'btn-outline-secondary', () => {
        Object.assign(state, { phase: 'candidates', suggestion: null, error: null });
        render();
      }),
      button(t('musicbrainz.cancel'), 'btn-outline-secondary', close),
    );
    return [
      source,
      table,
      el('p', 'small text-body-secondary mb-2', t('musicbrainz.hint')),
      actions,
    ];
  }

  /** @returns {Node[]} */
  function renderCandidates() {
    if (state.candidates.length === 0) {
      return [
        el('p', 'small mb-2', t('musicbrainz.noResult')),
        button(t('musicbrainz.cancel'), 'btn-outline-secondary', close),
      ];
    }
    const list = el('div', 'list-group mb-2');
    for (const candidate of state.candidates) {
      const item = /** @type {HTMLButtonElement} */ (
        el('button', 'list-group-item list-group-item-action')
      );
      item.type = 'button';
      item.disabled = state.phase === 'loading';
      item.append(el('span', 'd-block', `${candidate.artist} – ${candidate.title}`));
      const meta = [
        candidate.album,
        candidate.year,
        t('musicbrainz.score', { score: candidate.score }),
      ]
        .filter((v) => v !== null && v !== '')
        .join(' · ');
      item.append(el('small', 'text-body-secondary', meta));
      if (state.phase === 'loading' && state.chosen === candidate) item.classList.add('active');
      item.addEventListener('click', () => choose(candidate));
      list.append(item);
    }
    const hint = state.phase === 'loading' ? 'musicbrainz.loading' : 'musicbrainz.choose';
    return [
      el('p', 'small mb-2', t(hint)),
      list,
      button(t('musicbrainz.cancel'), 'btn-outline-secondary', close),
    ];
  }

  function render() {
    const song = state.song;
    subtitle.textContent = song ? [song.artist, song.title].filter(Boolean).join(' – ') : '';
    /** @type {Node[]} */
    const content = [];
    if (state.error) {
      const alert = el('div', 'alert alert-danger py-2 small mb-2', state.error);
      alert.setAttribute('role', 'alert');
      content.push(alert);
    }
    switch (state.phase) {
      case 'searching':
        content.push(el('p', 'small mb-0', t('musicbrainz.searching')));
        break;
      case 'failed':
        content.push(
          button(t('musicbrainz.retry'), 'btn-outline-primary me-2', search, 'arrow-repeat'),
          button(t('musicbrainz.cancel'), 'btn-outline-secondary', close),
        );
        break;
      case 'candidates':
      case 'loading':
        content.push(...renderCandidates());
        break;
      default:
        content.push(...renderSuggestion());
    }
    body.replaceChildren(...content);
  }

  return {
    /**
     * Ouvre la fenêtre et lance la recherche.
     * @param {Song} song
     */
    open(song) {
      Object.assign(state, {
        phase: 'searching',
        song,
        candidates: [],
        chosen: null,
        suggestion: null,
        error: null,
        applied: null,
      });
      render();
      bootstrapModal.show();
      search();
    },

    /** Retraduit (changement de langue). */
    refresh() {
      if (state.song) render();
    },
  };
}
