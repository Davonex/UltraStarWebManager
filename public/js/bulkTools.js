// @ts-check
/**
 * Fenêtre « Corrections en masse » (niveau écriture).
 *
 * Chaque outil suit le même déroulé : 1. simuler (rien n'est écrit), 2. choisir les fichiers,
 * 3. appliquer par lots avec une barre de progression, puis afficher le bilan.
 * Premier outil : conversion en UTF-8 sans BOM.
 *
 * @module bulkTools
 */
import { ApiError, bulkConvertToUtf8 } from './api.js';
import { chunk, summarizeResults } from './bulkCore.js';
import { t } from './i18n.js';

/** @typedef {import('./api.js').BulkCandidate} BulkCandidate */
/** @typedef {import('./api.js').BulkResult} BulkResult */

/** @param {unknown} error */
const codeOf = (error) => (error instanceof ApiError ? error.code : 'NETWORK_ERROR');

/**
 * Message d'erreur d'un fichier dans le bilan.
 * @param {string | undefined} code
 */
function resultMessage(code) {
  // En masse, « modifié ailleurs » veut dire : modifié depuis la simulation, donc ignoré.
  return code === 'SONG_CHANGED'
    ? t('bulk.changedSinceSimulation')
    : t(`errors.${code ?? 'INTERNAL_ERROR'}`);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.modal         Fenêtre (.modal Bootstrap) #bulk-modal.
 * @param {() => Promise<void>} options.onDone  Appelé après une conversion (recharger le catalogue).
 */
export function createBulkTools({ modal, onDone }) {
  const tool = /** @type {HTMLElement} */ (modal.querySelector('[data-bulk-tool="utf8"]'));
  /** @param {string} name */
  const part = (name) => /** @type {any} */ (tool.querySelector(`[data-part="${name}"]`));

  /** @type {HTMLButtonElement} */ const simulateButton = part('simulate');
  /** @type {HTMLButtonElement} */ const applyButton = part('apply');
  /** @type {HTMLElement} */ const status = part('status');
  /** @type {HTMLElement} */ const list = part('list');
  /** @type {HTMLInputElement} */ const selectAll = part('select-all');
  /** @type {HTMLTableSectionElement} */ const rows = part('rows');
  /** @type {HTMLProgressElement} */ const progress = part('progress');
  /** @type {HTMLUListElement} */ const errorList = part('errors');

  /**
   * État de l'outil, re-rendu à chaque changement (et au changement de langue).
   * @type {{
   *   phase: 'idle' | 'simulating' | 'ready' | 'applying' | 'done' | 'failed',
   *   candidates: BulkCandidate[],
   *   selected: Set<string>,
   *   done: number,
   *   total: number,
   *   results: BulkResult[],
   *   errorCode: string | null,
   * }}
   */
  const state = {
    phase: 'idle',
    candidates: [],
    selected: new Set(),
    done: 0,
    total: 0,
    results: [],
    errorCode: null,
  };

  /** @param {BulkCandidate} item */
  const label = (item) => [item.artist, item.title].filter(Boolean).join(' – ') || item.file;

  function renderRows() {
    rows.replaceChildren(
      ...state.candidates.map((item) => {
        const tr = document.createElement('tr');
        const checkCell = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'form-check-input';
        checkbox.checked = state.selected.has(item.id);
        checkbox.disabled = state.phase === 'applying';
        checkbox.setAttribute('aria-label', label(item));
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.selected.add(item.id);
          else state.selected.delete(item.id);
          render(false);
        });
        checkCell.append(checkbox);

        const songCell = document.createElement('td');
        songCell.textContent = label(item);
        const fileCell = document.createElement('td');
        fileCell.className = 'text-body-secondary small text-break';
        fileCell.textContent = item.file;
        const encodingCell = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'badge text-bg-warning';
        badge.textContent = item.from;
        encodingCell.append(badge);

        tr.append(checkCell, songCell, fileCell, encodingCell);
        return tr;
      }),
    );
  }

  function renderErrors() {
    const byId = new Map(state.candidates.map((item) => [item.id, item]));
    errorList.replaceChildren(
      ...state.results
        .filter((result) => result.status === 'error')
        .map((result) => {
          const li = document.createElement('li');
          const item = byId.get(result.id);
          li.textContent = `${item ? label(item) : result.id} : ${resultMessage(result.code)}`;
          return li;
        }),
    );
    errorList.hidden = errorList.childElementCount === 0;
  }

  function statusText() {
    switch (state.phase) {
      case 'simulating':
        return t('bulk.simulating');
      case 'ready':
        return state.candidates.length === 0
          ? t('bulk.utf8.none')
          : t('bulk.utf8.found', { count: state.candidates.length });
      case 'applying':
        return t('bulk.progress', { done: state.done, total: state.total });
      case 'done': {
        const summary = summarizeResults(state.results);
        return t('bulk.summary', summary);
      }
      case 'failed':
        return t(`errors.${state.errorCode}`);
      default:
        return '';
    }
  }

  /** @param {boolean} [withRows] Reconstruire aussi le tableau (inutile pour une simple case). */
  function render(withRows = true) {
    const busy = state.phase === 'simulating' || state.phase === 'applying';
    simulateButton.disabled = busy;
    simulateButton.classList.toggle('is-busy', state.phase === 'simulating');

    status.textContent = statusText();
    status.classList.toggle('text-danger', state.phase === 'failed');

    list.hidden = state.candidates.length === 0;
    if (withRows) renderRows();
    const count = state.selected.size;
    selectAll.checked = count > 0 && count === state.candidates.length;
    selectAll.indeterminate = count > 0 && count < state.candidates.length;
    selectAll.disabled = busy;

    applyButton.hidden = state.candidates.length === 0 || state.phase === 'done';
    applyButton.disabled = busy || count === 0;
    applyButton.textContent = t('bulk.utf8.apply', { count });

    progress.hidden = state.phase !== 'applying';
    progress.max = Math.max(state.total, 1);
    progress.value = state.done;

    renderErrors();
  }

  /** 1. Simulation : liste des fichiers concernés, tous cochés. */
  async function simulate() {
    Object.assign(state, { phase: 'simulating', results: [], errorCode: null });
    render();
    try {
      const { data } = await bulkConvertToUtf8({ dryRun: true });
      state.candidates = data.items ?? [];
      state.selected = new Set(state.candidates.map((item) => item.id));
      state.phase = 'ready';
    } catch (error) {
      console.error(error);
      Object.assign(state, { phase: 'failed', errorCode: codeOf(error), candidates: [] });
      state.selected.clear();
    }
    render();
  }

  /** 3. Application par lots sur les fichiers cochés. */
  async function apply() {
    const items = state.candidates
      .filter((item) => state.selected.has(item.id))
      .map((item) => ({ id: item.id, expectedModifiedAt: item.modifiedAt }));
    Object.assign(state, { phase: 'applying', done: 0, total: items.length, results: [] });
    render();
    try {
      for (const batch of chunk(items)) {
        const { data } = await bulkConvertToUtf8({ items: batch });
        state.results.push(...(data.results ?? []));
        state.done += batch.length;
        render(false);
      }
      state.phase = 'done';
    } catch (error) {
      console.error(error);
      Object.assign(state, { phase: 'failed', errorCode: codeOf(error) });
    }
    // Les fichiers convertis disparaissent de la liste ; restent ceux non traités ou en erreur.
    const converted = new Set(
      state.results.filter((result) => result.status !== 'error').map((result) => result.id),
    );
    state.candidates = state.candidates.filter((item) => !converted.has(item.id));
    state.selected = new Set([...state.selected].filter((id) => !converted.has(id)));
    render();
    if (converted.size > 0) await onDone();
  }

  simulateButton.addEventListener('click', simulate);
  applyButton.addEventListener('click', apply);
  selectAll.addEventListener('change', () => {
    state.selected = selectAll.checked
      ? new Set(state.candidates.map((item) => item.id))
      : new Set();
    render();
  });
  // À chaque ouverture, on repart d'une simulation fraîche (sauf pendant un traitement).
  modal.addEventListener('show.bs.modal', () => {
    if (state.phase !== 'applying') simulate();
  });

  return {
    /** Re-rendu des textes dynamiques (changement de langue). */
    refresh: () => render(),
  };
}
