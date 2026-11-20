// @ts-check
/**
 * Internationalisation côté navigateur : chargement des fichiers de langue,
 * traduction du HTML (attributs data-i18n*) et changement de langue.
 *
 * Utilisation dans le HTML :
 *   <span data-i18n="status.ok"></span>                    → textContent
 *   <input data-i18n-placeholder="filters.search" />       → placeholder
 *   <button data-i18n-title="…" data-i18n-aria-label="…">  → title / aria-label
 *
 * @module i18n
 */
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_NAMES,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  translate,
} from './i18nCore.js';

export { LANGUAGE_NAMES, SUPPORTED_LANGUAGES };

const STORAGE_KEY = 'usm.language';
const CHANGE_EVENT = 'i18n:change';
const ATTRIBUTE_BINDINGS = Object.freeze([
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-title', 'title'],
  ['data-i18n-aria-label', 'aria-label'],
]);

/** @typedef {import('./i18nCore.js').Messages} Messages */

const state = {
  language: DEFAULT_LANGUAGE,
  /** @type {Messages} */ messages: {},
  /** @type {Messages} */ fallbackMessages: {},
};

/**
 * @param {string} language
 * @returns {Promise<Messages>}
 */
async function loadMessages(language) {
  const res = await fetch(`/locales/${language}.json`);
  if (!res.ok) throw new Error(`Fichier de langue introuvable : ${language}`);
  return res.json();
}

/** @returns {string | null} */
function readStoredLanguage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // stockage indisponible (navigation privée, etc.)
  }
}

/** @param {string} language */
function storeLanguage(language) {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // sans conséquence : la langue sera simplement redétectée la prochaine fois
  }
}

/**
 * Traduit une clé dans la langue courante.
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params) {
  return translate(state, key, params);
}

/** @returns {string} Langue courante (« en », « fr »). */
export function getLanguage() {
  return state.language;
}

/**
 * Applique les traductions à tous les éléments marqués sous `root`.
 * @param {ParentNode} [root]
 */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(/** @type {string} */ (el.getAttribute('data-i18n')));
  }
  for (const [dataAttr, targetAttr] of ATTRIBUTE_BINDINGS) {
    for (const el of root.querySelectorAll(`[${dataAttr}]`)) {
      el.setAttribute(targetAttr, t(/** @type {string} */ (el.getAttribute(dataAttr))));
    }
  }
}

/**
 * Change la langue, la mémorise et retraduit la page.
 * @param {string} language
 */
export async function setLanguage(language) {
  const resolved = resolveLanguage({ stored: language });
  state.messages =
    resolved === DEFAULT_LANGUAGE ? state.fallbackMessages : await loadMessages(resolved);
  state.language = resolved;
  storeLanguage(resolved);
  document.documentElement.lang = resolved;
  document.title = t('app.title');
  applyTranslations();
  document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { language: resolved } }));
}

/**
 * Exécute `callback` à chaque changement de langue (pour retraduire le contenu dynamique).
 * @param {(language: string) => void} callback
 */
export function onLanguageChange(callback) {
  document.addEventListener(CHANGE_EVENT, (event) => {
    callback(/** @type {CustomEvent<{ language: string }>} */ (event).detail.language);
  });
}

/** Initialise l'i18n : anglais en repli, puis langue enregistrée ou du navigateur. */
export async function initI18n() {
  state.fallbackMessages = await loadMessages(DEFAULT_LANGUAGE);
  const language = resolveLanguage({
    stored: readStoredLanguage(),
    browser: navigator.languages ?? [navigator.language],
  });
  try {
    await setLanguage(language);
  } catch (error) {
    console.error(error);
    await setLanguage(DEFAULT_LANGUAGE);
  }
}
