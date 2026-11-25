// @ts-check
/**
 * Préférences (niveau admin) : le menu ⚙ propose deux entrées, chacune ouvre la fenêtre sur
 * sa partie (l'autre est masquée) :
 * - « Norme de nommage » : pour chaque élément (dossier, .txt, duo, audio…), activer la vérification
 *   et régler le modèle de nom, avec un aperçu ;
 * - « Les sauvegardes » : sauvegarde de l'original par action. Les .txt et les playlists sont
 *   toujours sauvegardés (affichés, non modifiables) ; la vidéo d'origine (conversion) et le
 *   MP3 (ReplayGain) peuvent ne pas l'être.
 * L'enregistrement relit la bibliothèque côté serveur (avertissements à jour).
 *
 * @module preferencesView
 */
import { ApiError, getSettings, saveSettings } from './api.js';
import { t } from './i18n.js';
import { hasPlaceholder, PREVIEW_EXTENSIONS, PREVIEW_SONG, previewName } from './namingPreview.js';

/** @typedef {import('./api.js').Settings} Settings */
/** @typedef {import('./api.js').NamingKind} NamingKind */
/** @typedef {import('./api.js').BackupKind} BackupKind */

/** @typedef {'naming' | 'backups'} Section */

/** Parties de la fenêtre : titre et icône. */
const SECTIONS = Object.freeze({
  naming: { title: 'preferences.namingMenu', icon: 'input-cursor-text' },
  backups: { title: 'preferences.backupsMenu', icon: 'archive' },
});

/** Sauvegardes : toujours faites (non modifiables), puis réglables. */
const ALWAYS_BACKED_UP = ['txt', 'playlists'];
const BACKUP_KINDS = /** @type {BackupKind[]} */ (['videoConversion', 'replayGain']);

/** Éléments, dans l'ordre d'affichage. */
const KINDS = /** @type {NamingKind[]} */ ([
  'folder',
  'txt',
  'duet',
  'audio',
  'video',
  'cover',
  'background',
  'vocals',
  'instrumental',
]);

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
 * @param {object} options
 * @param {HTMLElement} options.modal  Fenêtre #preferences-modal.
 * @param {() => Promise<void>} options.onSaved  Après enregistrement (recharger le catalogue).
 */
export function createPreferencesView({ modal, onSaved }) {
  const bootstrapModal = /** @type {any} */ (globalThis).bootstrap.Modal.getOrCreateInstance(modal);
  const title = /** @type {HTMLElement} */ (modal.querySelector('[data-part="title"]'));
  const titleIcon = /** @type {SVGUseElement} */ (modal.querySelector('[data-part="title-icon"]'));
  const sections = /** @type {NodeListOf<HTMLElement>} */ (
    modal.querySelectorAll('[data-section]')
  );
  /** Partie affichée. @type {Section} */
  let section = 'naming';
  const body = /** @type {HTMLElement} */ (modal.querySelector('[data-part="naming"]'));
  const backupsBody = /** @type {HTMLElement} */ (modal.querySelector('[data-part="backups"]'));
  const status = /** @type {HTMLElement} */ (modal.querySelector('[data-part="status"]'));
  const saveButton = /** @type {HTMLButtonElement} */ (modal.querySelector('[data-action="save"]'));
  const resetButton = /** @type {HTMLButtonElement} */ (
    modal.querySelector('[data-action="defaults"]')
  );

  /** @type {Settings | null} */
  let draft = null;
  /** @type {Settings | null} */
  let defaults = null;
  /** Élément refusé par le serveur, avec la raison. @type {{ kind: string, reason: string } | null} */
  let invalid = null;
  let busy = false;
  /** @type {{ kind: 'success' | 'danger', text: string } | null} */
  let message = null;

  function renderStatus() {
    status.replaceChildren();
    if (!message) return;
    const alert = el('div', `alert alert-${message.kind} py-2 small mb-0`, message.text);
    alert.setAttribute('role', message.kind === 'danger' ? 'alert' : 'status');
    status.append(alert);
  }

  function render() {
    title.textContent = t(SECTIONS[section].title);
    titleIcon.setAttribute(
      'href',
      `/img/vendor/bootstrap-icons/icons.svg#${SECTIONS[section].icon}`,
    );
    for (const node of sections) node.hidden = node.dataset.section !== section;
    saveButton.disabled = busy || !draft;
    resetButton.disabled = busy || !draft;
    renderStatus();
    if (!draft) {
      body.replaceChildren(el('p', 'small text-body-secondary', t('details.loading')));
      backupsBody.replaceChildren();
      return;
    }
    renderBackups(draft);
    const naming = draft.naming;
    const table = el('table', 'table table-sm align-middle mb-0 preferences-naming');
    const head = el('thead');
    const headRow = el('tr');
    for (const text of [
      t('preferences.item'),
      t('preferences.pattern'),
      t('preferences.preview'),
    ]) {
      const th = el('th', 'small text-body-secondary fw-normal', text);
      th.setAttribute('scope', 'col');
      headRow.append(th);
    }
    head.append(headRow);
    const rows = el('tbody');
    for (const kind of KINDS) {
      const rule = naming[kind];
      const tr = el('tr');

      const labelCell = el('th');
      labelCell.setAttribute('scope', 'row');
      const check = el('label', 'form-check mb-0');
      const toggle = /** @type {HTMLInputElement} */ (el('input', 'form-check-input'));
      toggle.type = 'checkbox';
      toggle.checked = rule.enabled;
      toggle.disabled = busy;
      toggle.addEventListener('change', () => {
        rule.enabled = toggle.checked;
        render();
      });
      check.append(
        toggle,
        el('span', 'form-check-label fw-normal', t(`preferences.kinds.${kind}`)),
      );
      labelCell.append(check);

      const inputCell = el('td');
      const input = /** @type {HTMLInputElement} */ (
        el('input', 'form-control form-control-sm font-monospace')
      );
      input.type = 'text';
      input.value = rule.pattern;
      input.disabled = busy || !rule.enabled;
      input.setAttribute(
        'aria-label',
        t('preferences.patternOf', { item: t(`preferences.kinds.${kind}`) }),
      );
      const preview = el('td', 'small text-body-secondary text-break');
      const feedback = el('div', 'invalid-feedback');
      const update = () => {
        rule.pattern = input.value;
        const serverError = invalid?.kind === kind ? invalid.reason : null;
        const error =
          serverError ?? (hasPlaceholder(input.value) ? null : 'PATTERN_NO_PLACEHOLDER');
        input.classList.toggle('is-invalid', rule.enabled && error !== null);
        feedback.textContent = error ? t(`preferences.errors.${error}`) : '';
        preview.textContent = rule.enabled
          ? `${previewName(input.value, PREVIEW_SONG.artist, PREVIEW_SONG.title)}${PREVIEW_EXTENSIONS[kind]}`
          : t('preferences.notChecked');
      };
      input.addEventListener('input', () => {
        if (invalid?.kind === kind) invalid = null;
        update();
      });
      update();
      inputCell.append(input, feedback);
      tr.append(labelCell, inputCell, preview);
      rows.append(tr);
    }
    table.append(head, rows);
    body.replaceChildren(table);
  }

  /**
   * Tableau « action → sauvegarde » : interrupteur par action réglable.
   * @param {Settings} settings
   */
  function renderBackups(settings) {
    const table = el('table', 'table table-sm align-middle mb-0 preferences-backups');
    const head = el('thead');
    const headRow = el('tr');
    for (const text of [t('preferences.action'), t('preferences.backup')]) {
      const th = el('th', 'small text-body-secondary fw-normal', text);
      th.setAttribute('scope', 'col');
      headRow.append(th);
    }
    head.append(headRow);
    const rows = el('tbody');
    /**
     * @param {string} kind
     * @param {boolean} checked
     * @param {((on: boolean) => void) | null} onChange  null : toujours sauvegardé.
     */
    const row = (kind, checked, onChange) => {
      const tr = el('tr');
      const label = el('th', 'fw-normal');
      label.setAttribute('scope', 'row');
      label.append(el('span', '', t(`preferences.backupKinds.${kind}`)));
      if (onChange && !checked) {
        label.append(el('small', 'd-block text-warning', t(`preferences.backupHints.${kind}`)));
      }
      const cell = el('td', 'text-nowrap');
      const wrap = el('div', 'form-check form-switch mb-0');
      const toggle = /** @type {HTMLInputElement} */ (el('input', 'form-check-input'));
      toggle.type = 'checkbox';
      toggle.role = 'switch';
      toggle.id = `backup-${kind}`;
      toggle.checked = checked;
      toggle.disabled = busy || onChange === null;
      toggle.setAttribute('aria-label', t(`preferences.backupKinds.${kind}`));
      if (onChange) {
        toggle.addEventListener('change', () => {
          onChange(toggle.checked);
          render();
        });
      }
      const text = el(
        'label',
        'form-check-label small',
        onChange === null ? t('preferences.always') : checked ? t('common.yes') : t('common.no'),
      );
      text.setAttribute('for', toggle.id);
      wrap.append(toggle, text);
      cell.append(wrap);
      tr.append(label, cell);
      return tr;
    };
    for (const kind of ALWAYS_BACKED_UP) rows.append(row(kind, true, null));
    for (const kind of BACKUP_KINDS) {
      rows.append(
        row(kind, settings.backups[kind], (on) => {
          settings.backups[kind] = on;
        }),
      );
    }
    table.append(head, rows);
    backupsBody.replaceChildren(table);
  }

  async function load() {
    draft = null;
    invalid = null;
    message = null;
    render();
    try {
      const { data, meta } = await getSettings();
      draft = structuredClone(data);
      defaults = meta.defaults;
    } catch (error) {
      message = {
        kind: 'danger',
        text: t(`errors.${error instanceof ApiError ? error.code : 'NETWORK_ERROR'}`),
      };
    }
    render();
  }

  async function save() {
    if (!draft || busy) return;
    busy = true;
    message = null;
    render();
    try {
      const { data } = await saveSettings(draft);
      draft = structuredClone(data);
      invalid = null;
      message = { kind: 'success', text: t('preferences.saved') };
      await onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_SETTINGS') {
        invalid = { kind: String(error.params.kind), reason: String(error.params.reason) };
        message = { kind: 'danger', text: t('preferences.invalid') };
      } else {
        message = {
          kind: 'danger',
          text: t(`errors.${error instanceof ApiError ? error.code : 'NETWORK_ERROR'}`),
        };
      }
    } finally {
      busy = false;
    }
    render();
  }

  saveButton.addEventListener('click', save);
  // « Valeurs par défaut » : seulement la partie affichée.
  resetButton.addEventListener('click', () => {
    if (!defaults || !draft) return;
    if (section === 'naming') draft.naming = structuredClone(defaults.naming);
    else draft.backups = structuredClone(defaults.backups);
    invalid = null;
    message = null;
    render();
  });

  return {
    /**
     * Ouvre la fenêtre sur une partie (entrées du menu ⚙).
     * @param {Section} name
     */
    open(name) {
      section = name;
      bootstrapModal.show();
      load();
    },

    /** Retraduit (changement de langue). */
    refresh: () => render(),
  };
}
