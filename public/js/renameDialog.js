// @ts-check
/**
 * Fenêtre « Renommer selon la norme », ouverte depuis l'avertissement de nommage de la
 * fenêtre info (niveau écriture). Comme MusicBrainz, elle remplace un moment la fenêtre info.
 *
 * 1. Simulation dès l'ouverture : le dossier et ses fichiers, nom actuel → nouveau nom
 *    (modifiable), avec un statut par ligne, puis l'effet sur chaque .txt ;
 * 2. chaque saisie relance la simulation (conflits mis à jour) ;
 * 3. « Renommer » applique tout d'un coup ; « Annuler ce renommage » remet tout en place.
 *
 * @module renameDialog
 */
import { ApiError, applyRename, previewRename, undoRename } from './api.js';
import { t } from './i18n.js';

/** @typedef {import('./api.js').Song} Song */
/** @typedef {import('./api.js').RenamePlan} RenamePlan */
/** @typedef {import('./api.js').RenameEntry} RenameEntry */
/** @typedef {'loading' | 'ready' | 'saving' | 'done' | 'undone' | 'failed'} Phase */

const ICONS = '/img/vendor/bootstrap-icons/icons.svg';
/** Délai avant de revalider une saisie (ms). */
const VALIDATE_DELAY_MS = 350;
/** Icône de chaque élément. */
const KIND_ICONS = Object.freeze({
  folder: 'folder2',
  txt: 'file-earmark-text',
  duet: 'file-earmark-text',
  audio: 'file-earmark-music',
  vocals: 'file-earmark-music',
  instrumental: 'file-earmark-music',
  video: 'film',
  cover: 'image',
  background: 'image',
  other: 'file-earmark',
});

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
 * @param {string} name
 * @param {string} [className]
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
 * @param {string} label
 * @param {string} className
 * @param {() => void} onClick
 * @param {string} [iconName]
 */
function button(label, className, onClick, iconName) {
  const node = /** @type {HTMLButtonElement} */ (el('button', `btn btn-sm ${className}`));
  node.type = 'button';
  if (iconName) node.append(icon(iconName, 'bi me-1'));
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

/** @param {RenameEntry['kind']} kind */
function kindLabel(kind) {
  return kind === 'folder' || kind === 'other'
    ? t(`rename.kinds.${kind}`)
    : t(`preferences.kinds.${kind}`);
}

/**
 * Statut affiché d'une ligne : libellé et classe de la pastille.
 * @param {RenameEntry} entry
 * @returns {[string, string]}
 */
function statusOf(entry) {
  if (entry.error) return [t('rename.status.conflict'), 'text-bg-danger'];
  if (entry.action === 'rename') return [t('rename.status.rename'), 'text-bg-primary'];
  if (entry.kind === 'other') return [t('rename.status.ignored'), 'text-bg-secondary'];
  if (entry.from === entry.proposed) return [t('rename.status.ok'), 'text-bg-success'];
  return [t('rename.status.kept'), 'text-bg-secondary'];
}

/**
 * @param {object} options
 * @param {HTMLElement} options.modal  Fenêtre #rename-modal (.modal Bootstrap).
 * @param {() => void} options.onBeforeApply  Avant d'écrire : arrêter la lecture (fichiers libérés).
 * @param {(result: { song: Song, songId: string, changed: boolean }) => void} options.onClosed
 *   À la fermeture : identifiant de la chanson à rouvrir (il change avec le chemin), et
 *   `changed` si des fichiers ont été renommés (catalogue à recharger).
 */
export function createRenameDialog({ modal, onBeforeApply, onClosed }) {
  const body = /** @type {HTMLElement} */ (modal.querySelector('.modal-body'));
  const footer = /** @type {HTMLElement} */ (modal.querySelector('.modal-footer'));
  const subtitle = /** @type {HTMLElement} */ (modal.querySelector('.rename-subtitle'));
  const bootstrapModal = /** @type {any} */ (globalThis).bootstrap.Modal.getOrCreateInstance(modal);

  /**
   * @type {{
   *   phase: Phase,
   *   song: Song | null,
   *   plan: RenamePlan | null,
   *   overrides: { folder?: string, files: Record<string, string> },
   *   error: string | null,
   *   result: { songId: string | null, journal: string | null, renamed: number, backups: string[] } | null,
   *   changed: boolean,
   * }}
   */
  const state = {
    phase: 'loading',
    song: null,
    plan: null,
    overrides: { files: {} },
    error: null,
    result: null,
    changed: false,
  };
  /** Lignes affichées, par nom actuel (mises à jour sans perdre la saisie en cours). */
  /** @type {Map<string, { input: HTMLInputElement, status: HTMLElement, feedback: HTMLElement }>} */
  let rows = new Map();
  /** @type {HTMLElement | null} */
  let txtSection = null;
  /** Numéro de la dernière simulation demandée (ignore les réponses dépassées). */
  let request = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  modal.addEventListener('hidden.bs.modal', () => {
    clearTimeout(timer);
    const song = state.song;
    if (!song) return;
    const songId = state.phase === 'done' ? (state.result?.songId ?? song.id) : song.id; // annulé : même chemin
    onClosed({ song, songId, changed: state.changed });
    state.song = null;
  });

  // --- Simulation ----------------------------------------------------------------------

  /** Relance la simulation avec les noms saisis. */
  async function simulate() {
    const song = state.song;
    if (!song) return;
    const id = ++request;
    try {
      const { data } = await previewRename(song.id, state.overrides);
      if (id !== request || state.song !== song) return;
      const first = state.plan === null;
      state.plan = data;
      state.error = null;
      if (first) {
        state.phase = 'ready';
        render();
      } else {
        update();
      }
    } catch (error) {
      if (id !== request) return;
      state.error = errorText(error);
      if (state.plan === null) state.phase = 'failed';
      render();
    }
  }

  /**
   * Nouvelle saisie d'un nom : simulation relancée après une courte pause.
   * @param {RenameEntry} entry
   * @param {string} value
   */
  function typed(entry, value) {
    if (entry.kind === 'folder') state.overrides.folder = value;
    else state.overrides.files[entry.from] = value;
    clearTimeout(timer);
    footerButtons(true); // pas d'application pendant la saisie
    timer = setTimeout(simulate, VALIDATE_DELAY_MS);
  }

  // --- Affichage -----------------------------------------------------------------------

  /**
   * Ligne du tableau pour un élément.
   * @param {RenameEntry} entry
   */
  function row(entry) {
    const tr = el('tr', entry.kind === 'folder' ? 'rename-folder' : '');
    const nameCell = el('td', 'text-break');
    nameCell.append(icon(KIND_ICONS[entry.kind], 'bi me-2 text-body-secondary'), entry.from);
    const kind = el('div', 'small text-body-secondary', kindLabel(entry.kind));
    if (entry.usedBy.length > 1 && entry.kind !== 'folder') {
      kind.textContent += ` · ${t('rename.sharedBy', { count: entry.usedBy.length })}`;
    }
    nameCell.append(kind);

    const targetCell = el('td');
    const feedback = el('div', 'invalid-feedback');
    const group = el('div', 'input-group input-group-sm has-validation');
    const input = /** @type {HTMLInputElement} */ (el('input', 'form-control font-monospace'));
    input.type = 'text';
    input.value = entry.to;
    input.spellcheck = false;
    input.setAttribute('aria-label', t('rename.newNameOf', { name: entry.from }));
    input.addEventListener('input', () => typed(entry, input.value));
    // ↺ : nom proposé par la norme (pour un fichier non cité : son nom actuel)
    const reset = button('', 'btn-outline-secondary', () => {
      input.value = entry.proposed;
      typed(entry, entry.proposed);
    });
    reset.append(icon('arrow-counterclockwise'));
    reset.title = t('rename.reset');
    reset.setAttribute('aria-label', t('rename.reset'));
    group.append(input, reset, feedback);
    targetCell.append(group);
    const status = el('span', 'badge');
    const statusCell = el('td', 'text-end');
    statusCell.append(status);
    tr.append(nameCell, targetCell, statusCell);
    rows.set(`${entry.kind === 'folder' ? 'folder:' : 'file:'}${entry.from}`, {
      input,
      status,
      feedback,
    });
    return tr;
  }

  /** Statuts, conflits et effet sur les .txt, d'après la dernière simulation. */
  function update() {
    const plan = state.plan;
    if (!plan) return;
    const entries = plan.folder ? [plan.folder, ...plan.files] : plan.files;
    for (const entry of entries) {
      const line = rows.get(`${entry.kind === 'folder' ? 'folder:' : 'file:'}${entry.from}`);
      if (!line) continue;
      const [label, className] = statusOf(entry);
      line.status.className = `badge ${className}`;
      line.status.textContent = label;
      line.input.classList.toggle('is-invalid', entry.error !== null);
      line.feedback.textContent = entry.error ? t(`rename.errors.${entry.error}`) : '';
    }
    txtSection?.replaceChildren(...txtChanges(plan));
    footerButtons(false);
  }

  /**
   * Effet sur chaque .txt : nouveau nom et en-têtes modifiés.
   * @param {RenamePlan} plan
   * @returns {Node[]}
   */
  function txtChanges(plan) {
    const nodes = [];
    for (const { character, txtFile } of plan.unencodable) {
      nodes.push(
        el('div', 'alert alert-danger py-2 small', t('rename.unencodable', { character, txtFile })),
      );
    }
    const changed = plan.txts.filter((x) => x.changes.length > 0 || x.newTxtFile !== x.txtFile);
    if (changed.length === 0) {
      nodes.push(el('p', 'small text-body-secondary mb-0', t('rename.noTxtChange')));
      return nodes;
    }
    for (const txt of changed) {
      const block = el('div', 'rename-diff mb-2');
      const head = el('div', 'rename-diff-head small fw-semibold text-break');
      head.append(icon('file-earmark-text', 'bi me-1'), txt.txtFile);
      if (txt.newTxtFile !== txt.txtFile) {
        head.append(icon('arrow-right', 'bi mx-1'), txt.newTxtFile);
      }
      block.append(head);
      if (txt.changes.length === 0) {
        block.append(el('div', 'small text-body-secondary px-2 py-1', t('rename.onlyName')));
      }
      for (const change of txt.changes) {
        if (change.before !== null) {
          block.append(el('div', 'rename-diff-del', `- #${change.header}:${change.before}`));
        }
        if (change.after !== null) {
          block.append(el('div', 'rename-diff-add', `+ #${change.header}:${change.after}`));
        }
      }
      nodes.push(block);
    }
    return nodes;
  }

  /**
   * Boutons du bas selon l'état.
   * @param {boolean} pending  Saisie en attente de validation.
   */
  function footerButtons(pending) {
    const plan = state.plan;
    footer.replaceChildren();
    const summary = el('div', 'me-auto small text-body-secondary');
    footer.append(summary);
    if (state.phase === 'done' || state.phase === 'undone') {
      if (state.phase === 'done' && state.result?.journal) {
        const journal = state.result.journal;
        footer.append(
          button(
            t('rename.undo'),
            'btn-outline-secondary',
            () => undo(journal),
            'arrow-counterclockwise',
          ),
        );
      }
      footer.append(button(t('common.close'), 'btn-primary', () => bootstrapModal.hide()));
      return;
    }
    footer.append(button(t('rename.cancel'), 'btn-outline-secondary', () => bootstrapModal.hide()));
    if (!plan) return;
    const errors = plan.errorCount;
    // Aucun renommage mais des .txt à corriger (ex. #BACKGROUND retiré) : on met à jour les .txt.
    const txtOnly =
      plan.renameCount === 0 ? plan.txts.filter((x) => x.changes.length > 0).length : 0;
    summary.textContent = errors
      ? t('rename.summaryConflicts', { count: errors })
      : txtOnly > 0
        ? t('rename.summaryTxt', { count: txtOnly })
        : t('rename.summary', { count: plan.renameCount });
    const apply = button(
      txtOnly > 0
        ? t('rename.applyTxt', { count: txtOnly })
        : t('rename.apply', { count: plan.renameCount }),
      'btn-primary',
      () => applyPlan(),
      'input-cursor-text',
    );
    apply.disabled =
      pending || state.phase !== 'ready' || errors > 0 || (plan.renameCount === 0 && txtOnly === 0);
    footer.append(apply);
  }

  function render() {
    rows = new Map();
    txtSection = null;
    body.replaceChildren();
    const song = state.song;
    subtitle.textContent = song ? `${song.artist ?? '—'} — ${song.title ?? '—'}` : '';

    if (state.error) {
      const alert = el('div', 'alert alert-danger py-2', state.error);
      alert.setAttribute('role', 'alert');
      body.append(alert);
    }
    if (state.phase === 'loading') {
      body.append(el('p', 'text-body-secondary', t('details.loading')));
      footerButtons(true);
      return;
    }
    if (state.phase === 'done' || state.phase === 'undone') {
      const text =
        state.phase === 'done'
          ? t('rename.done', { count: state.result?.renamed ?? 0 })
          : t('rename.undone');
      const alert = el('div', 'alert alert-success py-2', text);
      alert.setAttribute('role', 'status');
      body.append(alert);
      if (state.phase === 'done' && state.result?.backups.length) {
        body.append(
          el(
            'p',
            'small text-body-secondary mb-0',
            t('rename.backups', {
              files: state.result.backups.join(', '),
            }),
          ),
        );
      }
      footerButtons(false);
      return;
    }
    const plan = state.plan;
    if (!plan) {
      footerButtons(false);
      return;
    }
    if (!plan.artist || !plan.title) {
      body.append(el('div', 'alert alert-warning py-2', t('rename.noIdentity')));
    }
    body.append(el('p', 'small text-body-secondary', t('rename.intro')));

    const table = el('table', 'table table-sm align-middle rename-table');
    const head = el('thead');
    const headRow = el('tr');
    for (const label of [t('rename.current'), t('rename.newName'), '']) {
      const th = el('th', 'small text-body-secondary fw-normal', label);
      th.setAttribute('scope', 'col');
      headRow.append(th);
    }
    head.append(headRow);
    const rowsBody = el('tbody');
    if (plan.folder) rowsBody.append(row(plan.folder));
    for (const entry of plan.files) rowsBody.append(row(entry));
    table.append(head, rowsBody);
    const wrapper = el('div', 'table-responsive');
    wrapper.append(table);
    body.append(wrapper);

    body.append(el('h3', 'h6 mt-3', t('rename.txtTitle')));
    txtSection = el('div');
    body.append(txtSection);
    update();
  }

  // --- Actions -------------------------------------------------------------------------

  /** Arrête la lecture avant d'écrire (un échec ici n'empêche pas le renommage). */
  function stopPlayback() {
    try {
      onBeforeApply();
    } catch (error) {
      console.error(error);
    }
  }

  async function applyPlan() {
    const song = state.song;
    const plan = state.plan;
    if (!song || !plan || state.phase !== 'ready') return;
    state.phase = 'saving';
    footerButtons(true);
    stopPlayback();
    try {
      const { data } = await applyRename(song.id, state.overrides, plan.expected);
      state.result = data;
      state.changed = data.renamed > 0;
      state.phase = 'done';
      state.error = null;
    } catch (error) {
      state.error = errorText(error);
      state.phase = 'ready';
      // Le dossier a pu changer : nouvelle simulation pour repartir d'un état juste.
      if (error instanceof ApiError && error.code === 'FOLDER_CHANGED') {
        state.plan = null;
        state.phase = 'loading';
        render();
        await simulate();
        state.error = errorText(error);
      }
    }
    render();
    body.scrollTop = 0;
  }

  /** @param {string} journal */
  async function undo(journal) {
    state.phase = 'saving';
    footerButtons(true);
    stopPlayback();
    try {
      await undoRename(journal);
      state.phase = 'undone';
      state.changed = true;
      state.error = null;
    } catch (error) {
      state.phase = 'done';
      state.error = errorText(error);
    }
    render();
  }

  return {
    /**
     * Ouvre la fenêtre pour une chanson : simulation immédiate.
     * @param {Song} song
     */
    open(song) {
      Object.assign(state, {
        phase: /** @type {Phase} */ ('loading'),
        song,
        plan: null,
        overrides: { files: {} },
        error: null,
        result: null,
        changed: false,
      });
      render();
      bootstrapModal.show();
      simulate();
    },

    /** Retraduit la fenêtre ouverte après un changement de langue. */
    refresh() {
      if (state.song) render();
    },
  };
}
