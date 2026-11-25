// @ts-check
/**
 * Corrections en masse, onglet « Vidéos » : conversion en MP4 H.264 par lots.
 *
 * 1. Simuler : liste des vidéos à convertir (format, résolution, taille) ; rien n'est écrit.
 * 2. Choisir les vidéos et la taille du lot (10 par défaut).
 * 3. Convertir : le serveur traite le lot en tâche de fond, vidéo après vidéo ; on suit
 *    l'avancement (la fenêtre peut être fermée) et on peut arrêter après la vidéo en cours.
 *    À la fin : bilan, nouvelle simulation (les vidéos converties disparaissent de la liste).
 *
 * @module bulkVideoTool
 */
import { ApiError, bulkConvertVideos, getVideoBatch, stopVideoBatch } from './api.js';
import { getLanguage, t } from './i18n.js';

/** @typedef {import('./api.js').VideoCandidate} VideoCandidate */
/** @typedef {import('./api.js').VideoBatch} VideoBatch */

/** Le serveur accepte au plus 200 vidéos par lot. */
const MAX_BATCH = 200;
/** Intervalle de suivi d'un lot (ms). */
const POLL_MS = 1500;

/** @param {unknown} error */
const codeOf = (error) => (error instanceof ApiError ? error.code : 'NETWORK_ERROR');

/**
 * « 412 Mo » (taille en mégaoctets, arrondie).
 * @param {number} bytes
 */
function megabytes(bytes) {
  const value = (bytes / 1_000_000).toLocaleString(getLanguage(), {
    maximumFractionDigits: bytes < 10_000_000 ? 1 : 0,
  });
  return t('bulk.megabytes', { value });
}

/** @param {{ artist: string | null, title: string | null }} item */
const songLabel = (item) => [item.artist, item.title].filter(Boolean).join(' – ') || '?';

/**
 * @param {object} options
 * @param {HTMLElement} options.modal         Fenêtre #bulk-modal.
 * @param {() => Promise<void>} options.onDone  Après un lot (recharger le catalogue).
 */
export function createBulkVideoTool({ modal, onDone }) {
  const tool = /** @type {HTMLElement} */ (modal.querySelector('[data-bulk-tool="video"]'));
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
   *   candidates: VideoCandidate[],
   *   selected: Set<string>,
   *   batch: VideoBatch | null,      // lot suivi (en cours ou terminé)
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

  /** Vidéos cochées qui partiront dans le prochain lot. */
  function nextBatch() {
    const size = Number(batchSize.value) || MAX_BATCH;
    return state.candidates
      .filter((item) => state.selected.has(item.id) && !item.isAudio)
      .slice(0, Math.min(size, MAX_BATCH));
  }

  /** @param {VideoCandidate} item */
  function format(item) {
    return [item.container.toUpperCase(), item.codec?.toUpperCase()].filter(Boolean).join(' · ');
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
        // Vidéo qui sert aussi de #MP3 : listée pour information, jamais convertie.
        checkbox.disabled = item.isAudio;
        checkbox.setAttribute('aria-label', songLabel(item));
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.selected.add(item.id);
          else state.selected.delete(item.id);
          render(false);
        });
        checkCell.append(checkbox);

        const songCell = document.createElement('td');
        songCell.textContent = songLabel(item);
        if (item.isAudio) {
          const reason = document.createElement('small');
          reason.className = 'd-block text-danger';
          reason.textContent = t('bulk.video.isAudio');
          songCell.append(reason);
          tr.classList.add('text-body-secondary');
        }
        const formatCell = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'badge text-bg-warning';
        badge.textContent = format(item);
        formatCell.append(badge);
        const sizeCell = document.createElement('td');
        sizeCell.textContent = item.width && item.height ? `${item.width} × ${item.height}` : '—';
        if (item.oversized) {
          const reason = document.createElement('small');
          reason.className = 'd-block text-warning';
          reason.textContent = `→ 1080p`;
          sizeCell.append(reason);
        }
        const bytesCell = document.createElement('td');
        bytesCell.className = 'text-end text-nowrap';
        bytesCell.textContent = item.size === null ? '—' : megabytes(item.size);

        tr.append(checkCell, songCell, formatCell, sizeCell, bytesCell);
        return tr;
      }),
    );
  }

  function statusText() {
    switch (state.phase) {
      case 'simulating':
        return t('bulk.simulating');
      case 'ready':
      case 'starting': {
        if (!state.available) return t('video.unavailable');
        if (state.candidates.length === 0) return t('bulk.video.none');
        const total = state.candidates.reduce((sum, item) => sum + (item.size ?? 0), 0);
        return t('bulk.video.found', { count: state.candidates.length, size: megabytes(total) });
      }
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
    const fraction = item?.progress ?? 0;
    progress.max = total;
    progress.value = done + fraction;
    current.textContent = item
      ? t('bulk.video.current', {
          index: done + 1,
          total,
          song: songLabel(item),
          percent: Math.round(fraction * 100),
        })
      : t('bulk.video.finishing');
    stopButton.disabled = batch.stopRequested;
    const label = /** @type {HTMLElement} */ (stopButton.querySelector('span'));
    label.textContent = t(batch.stopRequested ? 'bulk.video.stopping' : 'bulk.video.stop');
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
      batch.state === 'stopped' ? 'bulk.video.stopped' : 'bulk.video.summary',
      {
        converted: count('converted'),
        errors: count('error'),
        skipped: count('skipped'),
      },
    );
    errorList.replaceChildren(
      ...batch.items
        .filter((item) => item.status === 'error')
        .map((item) => {
          const li = document.createElement('li');
          const message =
            item.code === 'SONG_CHANGED'
              ? t('bulk.changedSinceSimulation')
              : t(`errors.${item.code ?? 'VIDEO_CONVERSION_FAILED'}`, { file: '' });
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

    const total = state.candidates
      .filter((item) => state.selected.has(item.id))
      .reduce((sum, item) => sum + (item.size ?? 0), 0);
    note.hidden = state.phase === 'running' || state.candidates.length === 0;
    note.textContent = state.backup
      ? t('bulk.video.space', { size: megabytes(total) })
      : t('bulk.video.noBackup');

    list.hidden = state.phase === 'running' || state.candidates.length === 0;
    if (withRows) renderRows();
    const count = state.selected.size;
    const selectable = state.candidates.filter((item) => !item.isAudio).length;
    selectAll.checked = count > 0 && count === selectable;
    selectAll.indeterminate = count > 0 && count < selectable;

    const next = nextBatch().length;
    applyButton.textContent = t('bulk.video.apply', { count: next });
    applyButton.disabled = busy || !state.available || next === 0;
    batchSize.disabled = busy;

    renderRunning();
    renderSummary();
  }

  /** 1. Simulation. */
  async function simulate() {
    state.phase = 'simulating';
    render(false);
    try {
      const { data } = await bulkConvertVideos({ dryRun: true });
      state.available = data.available ?? false;
      state.backup = data.backup ?? true;
      state.candidates = data.items ?? [];
      state.selected = new Set(state.candidates.filter((i) => !i.isAudio).map((i) => i.id));
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
      const { data } = await bulkConvertVideos({ items });
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
        const { data } = await getVideoBatch();
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
      await simulate(); // les vidéos converties disparaissent de la liste
    }, POLL_MS);
  }

  simulateButton.addEventListener('click', () => {
    state.batch = null; // nouvelle simulation : on efface le bilan précédent
    simulate();
  });
  applyButton.addEventListener('click', apply);
  batchSize.addEventListener('change', () => render(false));
  selectAll.addEventListener('change', () => {
    state.selected = selectAll.checked
      ? new Set(state.candidates.filter((item) => !item.isAudio).map((item) => item.id))
      : new Set();
    render();
  });
  stopButton.addEventListener('click', async () => {
    try {
      const { data } = await stopVideoBatch();
      state.batch = data.batch;
    } catch (error) {
      console.error(error);
    }
    render(false);
  });

  // À l'ouverture : reprend le suivi d'un lot en cours (lancé avant un rechargement de page),
  // sinon nouvelle simulation.
  modal.addEventListener('show.bs.modal', async () => {
    if (state.phase === 'running' || state.phase === 'starting') return;
    try {
      const { data } = await getVideoBatch();
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
