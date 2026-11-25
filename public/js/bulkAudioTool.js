// @ts-check
/**
 * Corrections en masse, onglet « Musique » : création du MP3 des chansons dont la vidéo sert
 * aussi de musique (#MP3 = #VIDEO).
 *
 * 1. Simuler : liste des chansons concernées et du MP3 qui sera créé ; rien n'est écrit.
 * 2. Choisir les chansons.
 * 3. Créer : le serveur traite le lot en tâche de fond, chanson après chanson (ffmpeg) ; on
 *    suit l'avancement (la fenêtre peut être fermée) et on peut arrêter après la chanson en
 *    cours. À la fin : bilan, nouvelle simulation (les chansons traitées disparaissent).
 *
 * @module bulkAudioTool
 */
import { ApiError, bulkExtractAudio, getAudioBatch, stopAudioBatch } from './api.js';
import { t } from './i18n.js';

/** @typedef {import('./api.js').AudioCandidate} AudioCandidate */
/** @typedef {import('./api.js').VideoBatch} VideoBatch */

/** Le serveur accepte au plus 200 chansons par lot. */
const MAX_BATCH = 200;
/** Intervalle de suivi d'un lot (ms). */
const POLL_MS = 1500;

/** @param {unknown} error */
const codeOf = (error) => (error instanceof ApiError ? error.code : 'NETWORK_ERROR');

/** @param {{ artist: string | null, title: string | null }} item */
const songLabel = (item) => [item.artist, item.title].filter(Boolean).join(' – ') || '?';

/**
 * @param {object} options
 * @param {HTMLElement} options.modal         Fenêtre #bulk-modal.
 * @param {() => Promise<void>} options.onDone  Après un lot (recharger le catalogue).
 */
export function createBulkAudioTool({ modal, onDone }) {
  const tool = /** @type {HTMLElement} */ (modal.querySelector('[data-bulk-tool="audio"]'));
  /** @param {string} name */
  const part = (name) => /** @type {any} */ (tool.querySelector(`[data-part="${name}"]`));

  /** @type {HTMLButtonElement} */ const simulateButton = part('simulate');
  /** @type {HTMLElement} */ const status = part('status');
  /** @type {HTMLElement} */ const running = part('running');
  /** @type {HTMLProgressElement} */ const progress = part('progress');
  /** @type {HTMLElement} */ const current = part('current');
  /** @type {HTMLButtonElement} */ const stopButton = part('stop');
  /** @type {HTMLElement} */ const summary = part('summary');
  /** @type {HTMLUListElement} */ const errorList = part('errors');
  /** @type {HTMLElement} */ const list = part('list');
  /** @type {HTMLInputElement} */ const selectAll = part('select-all');
  /** @type {HTMLTableSectionElement} */ const rows = part('rows');
  /** @type {HTMLButtonElement} */ const applyButton = part('apply');

  /**
   * @type {{
   *   phase: 'idle' | 'simulating' | 'ready' | 'starting' | 'running' | 'failed',
   *   available: boolean,
   *   candidates: AudioCandidate[],
   *   selected: Set<string>,
   *   batch: VideoBatch | null,      // lot suivi (en cours ou terminé)
   *   errorCode: string | null,
   * }}
   */
  const state = {
    phase: 'idle',
    available: true,
    candidates: [],
    selected: new Set(),
    batch: null,
    errorCode: null,
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** Chansons cochées qui partiront dans le prochain lot. */
  const nextBatch = () =>
    state.candidates.filter((item) => state.selected.has(item.id)).slice(0, MAX_BATCH);

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
        const videoCell = document.createElement('td');
        videoCell.className = 'text-break small';
        videoCell.textContent = item.file;
        const targetCell = document.createElement('td');
        targetCell.className = 'text-break small';
        targetCell.textContent = item.target;
        if (item.reuse) {
          // MP3 déjà présent (ex. créé pour l'autre .txt du dossier) : seul le .txt change
          const reuse = document.createElement('small');
          reuse.className = 'd-block text-body-secondary';
          reuse.textContent = t('bulk.audio.reuse');
          targetCell.append(reuse);
        }
        tr.append(checkCell, songCell, videoCell, targetCell);
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
        if (state.candidates.length === 0) return t('bulk.audio.none');
        return t('bulk.audio.found', { count: state.candidates.length });
      case 'failed':
        return t(`errors.${state.errorCode}`);
      default:
        return '';
    }
  }

  /** Avancement du lot en cours. */
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
      ? t('bulk.audio.current', { index: done + 1, total, song: songLabel(item) })
      : t('bulk.video.finishing');
    stopButton.disabled = batch.stopRequested;
    const label = /** @type {HTMLElement} */ (stopButton.querySelector('span'));
    label.textContent = t(batch.stopRequested ? 'bulk.audio.stopping' : 'bulk.audio.stop');
  }

  /** Bilan et erreurs du dernier lot terminé. */
  function renderSummary() {
    const batch = state.phase !== 'running' ? state.batch : null;
    summary.hidden = !batch;
    errorList.hidden = true;
    if (!batch) return;
    const count = (/** @type {string} */ status) =>
      batch.items.filter((i) => i.status === status).length;
    summary.textContent = t(
      batch.state === 'stopped' ? 'bulk.audio.stopped' : 'bulk.audio.summary',
      { created: count('converted'), errors: count('error'), skipped: count('skipped') },
    );
    errorList.replaceChildren(
      ...batch.items
        .filter((item) => item.status === 'error')
        .map((item) => {
          const li = document.createElement('li');
          const message =
            item.code === 'SONG_CHANGED'
              ? t('bulk.changedSinceSimulation')
              : t(`errors.${item.code ?? 'AUDIO_EXTRACTION_FAILED'}`, { file: '' });
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

    list.hidden = state.phase === 'running' || state.candidates.length === 0;
    if (withRows) renderRows();
    const count = state.selected.size;
    selectAll.checked = count > 0 && count === state.candidates.length;
    selectAll.indeterminate = count > 0 && count < state.candidates.length;

    const next = nextBatch().length;
    applyButton.textContent = t('bulk.audio.apply', { count: next });
    applyButton.disabled = busy || !state.available || next === 0;

    renderRunning();
    renderSummary();
  }

  /** 1. Simulation. */
  async function simulate() {
    state.phase = 'simulating';
    render(false);
    try {
      const { data } = await bulkExtractAudio({ dryRun: true });
      state.available = data.available ?? false;
      state.candidates = data.items ?? [];
      state.selected = new Set(state.candidates.map((i) => i.id));
      state.phase = 'ready';
    } catch (error) {
      console.error(error);
      Object.assign(state, { phase: 'failed', errorCode: codeOf(error), candidates: [] });
    }
    render();
  }

  /** 3. Lancement du lot. */
  async function apply() {
    const items = nextBatch().map((item) => ({ id: item.id, expectedModifiedAt: item.modifiedAt }));
    if (items.length === 0) return;
    state.phase = 'starting';
    render(false);
    try {
      const { data } = await bulkExtractAudio({ items });
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
        const { data } = await getAudioBatch();
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
      await simulate(); // les chansons traitées disparaissent de la liste
    }, POLL_MS);
  }

  simulateButton.addEventListener('click', () => {
    state.batch = null; // nouvelle simulation : on efface le bilan précédent
    simulate();
  });
  applyButton.addEventListener('click', apply);
  selectAll.addEventListener('change', () => {
    state.selected = selectAll.checked
      ? new Set(state.candidates.map((item) => item.id))
      : new Set();
    render();
  });
  stopButton.addEventListener('click', async () => {
    try {
      const { data } = await stopAudioBatch();
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
      const { data } = await getAudioBatch();
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
