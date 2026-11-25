// @ts-check
/**
 * Corrections en masse, onglet « ReplayGain » : calcul et écriture du ReplayGain des MP3 qui
 * n'en ont pas (même traitement que le bouton de la fenêtre info).
 *
 * 1. Simuler : liste des MP3 sans ReplayGain (un par fichier : le solo et le duo partagent
 *    souvent le même), avec leur taille ; rien n'est écrit.
 * 2. Choisir les fichiers et la taille du lot (20 par défaut).
 * 3. Calculer : le serveur traite le lot en tâche de fond, fichier après fichier (ffmpeg
 *    décode chaque morceau, puis le tag ID3 est écrit après une sauvegarde du MP3) ; on suit
 *    l'avancement (la fenêtre peut être fermée) et on peut arrêter après le fichier en cours.
 *
 * @module bulkReplayGainTool
 */
import { ApiError, bulkReplayGain, getReplayGainBatch, stopReplayGainBatch } from './api.js';
import { getLanguage, t } from './i18n.js';

/** @typedef {import('./api.js').ReplayGainCandidate} ReplayGainCandidate */
/** @typedef {import('./api.js').ReplayGainBatch} ReplayGainBatch */

/** Le serveur accepte au plus 200 fichiers par lot. */
const MAX_BATCH = 200;
/** Intervalle de suivi d'un lot (ms). */
const POLL_MS = 1500;

/** @param {unknown} error */
const codeOf = (error) => (error instanceof ApiError ? error.code : 'NETWORK_ERROR');

/** @param {{ artist: string | null, title: string | null }} item */
const songLabel = (item) => [item.artist, item.title].filter(Boolean).join(' – ') || '?';

/** « 412 Mo ». @param {number} bytes */
function megabytes(bytes) {
  const value = (bytes / 1_000_000).toLocaleString(getLanguage(), {
    maximumFractionDigits: bytes < 10_000_000 ? 1 : 0,
  });
  return t('bulk.megabytes', { value });
}

/**
 * @param {object} options
 * @param {HTMLElement} options.modal         Fenêtre #bulk-modal.
 * @param {() => Promise<void>} options.onDone  Après un lot (recharger le catalogue).
 */
export function createBulkReplayGainTool({ modal, onDone }) {
  const tool = /** @type {HTMLElement} */ (modal.querySelector('[data-bulk-tool="replaygain"]'));
  /** @param {string} name */
  const part = (name) => /** @type {any} */ (tool.querySelector(`[data-part="${name}"]`));

  /** @type {HTMLButtonElement} */ const simulateButton = part('simulate');
  /** @type {HTMLElement} */ const status = part('status');
  /** @type {HTMLElement} */ const note = part('note');
  /** @type {HTMLElement} */ const running = part('running');
  /** @type {HTMLProgressElement} */ const progress = part('progress');
  /** @type {HTMLElement} */ const current = part('current');
  /** @type {HTMLButtonElement} */ const stopButton = part('stop');
  /** @type {HTMLElement} */ const summary = part('summary');
  /** @type {HTMLUListElement} */ const errorList = part('errors');
  /** @type {HTMLElement} */ const list = part('list');
  /** @type {HTMLInputElement} */ const selectAll = part('select-all');
  /** @type {HTMLTableSectionElement} */ const rows = part('rows');
  /** @type {HTMLSelectElement} */ const batchSize = part('batch-size');
  /** @type {HTMLButtonElement} */ const applyButton = part('apply');

  /**
   * @type {{
   *   phase: 'idle' | 'simulating' | 'ready' | 'starting' | 'running' | 'failed',
   *   available: boolean,
   *   backup: boolean,        // originaux sauvegardés (préférences)
   *   candidates: ReplayGainCandidate[],
   *   selected: Set<string>,
   *   batch: ReplayGainBatch | null,
   *   errorCode: string | null,
   * }}
   */
  const state = {
    phase: 'idle',
    available: true,
    backup: true,
    candidates: [],
    selected: new Set(),
    batch: null,
    errorCode: null,
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** Fichiers cochés qui partiront dans le prochain lot. */
  function nextBatch() {
    const size = Number(batchSize.value) || MAX_BATCH;
    return state.candidates
      .filter((item) => state.selected.has(item.id))
      .slice(0, Math.min(size, MAX_BATCH));
  }

  function renderRows() {
    rows.replaceChildren(
      ...state.candidates.map((item) => {
        const tr = document.createElement('tr');
        const checkCell = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'form-check-input';
        checkbox.checked = state.selected.has(item.id);
        checkbox.setAttribute('aria-label', songLabel(item));
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.selected.add(item.id);
          else state.selected.delete(item.id);
          render(false);
        });
        checkCell.append(checkbox);
        const songCell = document.createElement('td');
        songCell.textContent = songLabel(item);
        if (item.sharedBy > 0) {
          const shared = document.createElement('small');
          shared.className = 'd-block text-body-secondary';
          shared.textContent = t('bulk.replayGain.shared', { count: item.sharedBy });
          songCell.append(shared);
        }
        const fileCell = document.createElement('td');
        fileCell.className = 'text-break small';
        fileCell.textContent = item.file;
        const sizeCell = document.createElement('td');
        sizeCell.className = 'text-end text-nowrap';
        sizeCell.textContent = item.size === null ? '—' : megabytes(item.size);
        tr.append(checkCell, songCell, fileCell, sizeCell);
        return tr;
      }),
    );
  }

  function statusText() {
    switch (state.phase) {
      case 'simulating':
        return t('bulk.simulating');
      case 'ready':
      case 'starting':
        if (!state.available) return t('video.unavailable');
        if (state.candidates.length === 0) return t('bulk.replayGain.none');
        return t('bulk.replayGain.found', { count: state.candidates.length });
      case 'failed':
        return t(`errors.${state.errorCode}`);
      default:
        return '';
    }
  }

  function renderRunning() {
    const batch = state.batch;
    const active = state.phase === 'running' && batch !== null;
    running.hidden = !active;
    if (!active) return;
    const total = batch.items.length;
    const done = batch.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length;
    const item = batch.items.find((i) => i.status === 'running');
    progress.max = total;
    progress.value = done;
    current.textContent = item
      ? t('bulk.replayGain.current', { index: done + 1, total, song: songLabel(item) })
      : t('bulk.video.finishing');
    stopButton.disabled = batch.stopRequested;
    const label = /** @type {HTMLElement} */ (stopButton.querySelector('span'));
    label.textContent = t(
      batch.stopRequested ? 'bulk.replayGain.stopping' : 'bulk.replayGain.stop',
    );
  }

  function renderSummary() {
    const batch = state.phase !== 'running' ? state.batch : null;
    summary.hidden = !batch;
    errorList.hidden = true;
    if (!batch) return;
    const count = (/** @type {string} */ status) =>
      batch.items.filter((i) => i.status === status).length;
    summary.textContent = t(
      batch.state === 'stopped' ? 'bulk.replayGain.stopped' : 'bulk.replayGain.summary',
      { written: count('converted'), errors: count('error'), skipped: count('skipped') },
    );
    errorList.replaceChildren(
      ...batch.items
        .filter((item) => item.status === 'error')
        .map((item) => {
          const li = document.createElement('li');
          const message =
            item.code === 'SONG_CHANGED'
              ? t('bulk.changedSinceSimulation')
              : t(`errors.${item.code ?? 'REPLAYGAIN_FAILED'}`, { file: '' });
          li.textContent = `${songLabel(item)} : ${message}`;
          return li;
        }),
    );
    errorList.hidden = errorList.childElementCount === 0;
  }

  /** @param {boolean} [withRows] */
  function render(withRows = true) {
    const busy =
      state.phase === 'simulating' || state.phase === 'starting' || state.phase === 'running';
    simulateButton.disabled = busy;
    status.textContent = statusText();
    status.classList.toggle(
      'text-danger',
      state.phase === 'failed' || (state.phase === 'ready' && !state.available),
    );
    const next = nextBatch();
    const space = next.reduce((sum, item) => sum + (item.size ?? 0), 0);
    note.hidden = state.phase === 'running' || state.candidates.length === 0;
    note.textContent = state.backup
      ? t('bulk.replayGain.space', { size: megabytes(space) })
      : t('bulk.replayGain.noBackup');

    list.hidden = state.phase === 'running' || state.candidates.length === 0;
    if (withRows) renderRows();
    const count = state.selected.size;
    selectAll.checked = count > 0 && count === state.candidates.length;
    selectAll.indeterminate = count > 0 && count < state.candidates.length;
    applyButton.textContent = t('bulk.replayGain.apply', { count: next.length });
    applyButton.disabled = busy || !state.available || next.length === 0;
    batchSize.disabled = busy;
    renderRunning();
    renderSummary();
  }

  async function simulate() {
    state.phase = 'simulating';
    render(false);
    try {
      const { data } = await bulkReplayGain({ dryRun: true });
      state.available = data.available ?? false;
      state.backup = data.backup ?? true;
      state.candidates = data.items ?? [];
      state.selected = new Set(state.candidates.map((i) => i.id));
      state.phase = 'ready';
    } catch (error) {
      console.error(error);
      Object.assign(state, { phase: 'failed', errorCode: codeOf(error), candidates: [] });
    }
    render();
  }

  async function apply() {
    const items = nextBatch().map((item) => ({
      id: item.id,
      expectedAudioModifiedAt: item.audioModifiedAt,
    }));
    if (items.length === 0) return;
    state.phase = 'starting';
    render(false);
    try {
      const { data } = await bulkReplayGain({ items });
      state.batch = data.batch ?? null;
      state.phase = 'running';
      poll();
    } catch (error) {
      console.error(error);
      Object.assign(state, { phase: 'failed', errorCode: codeOf(error) });
    }
    render(false);
  }

  /** Suivi du lot (continue fenêtre fermée : la grille est rechargée à la fin). */
  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const { data } = await getReplayGainBatch();
        state.batch = data.batch;
      } catch (error) {
        console.error(error);
      }
      if (state.batch?.state === 'running') {
        render(false);
        poll();
        return;
      }
      state.phase = 'ready';
      render(false);
      await onDone();
      await simulate(); // les fichiers traités disparaissent de la liste
    }, POLL_MS);
  }

  simulateButton.addEventListener('click', () => {
    state.batch = null;
    simulate();
  });
  applyButton.addEventListener('click', apply);
  batchSize.addEventListener('change', () => render(false));
  selectAll.addEventListener('change', () => {
    state.selected = selectAll.checked
      ? new Set(state.candidates.map((item) => item.id))
      : new Set();
    render();
  });
  stopButton.addEventListener('click', async () => {
    try {
      const { data } = await stopReplayGainBatch();
      state.batch = data.batch;
    } catch (error) {
      console.error(error);
    }
    render(false);
  });

  // À l'ouverture : reprend le suivi d'un lot en cours, sinon nouvelle simulation.
  modal.addEventListener('show.bs.modal', async () => {
    if (state.phase === 'running' || state.phase === 'starting') return;
    try {
      const { data } = await getReplayGainBatch();
      if (data.batch?.state === 'running') {
        state.batch = data.batch;
        state.phase = 'running';
        render(false);
        poll();
        return;
      }
    } catch (error) {
      console.error(error);
    }
    simulate();
  });

  return {
    /** Re-rendu des textes (changement de langue). */
    refresh: () => render(),
  };
}
