// @ts-check
/**
 * Cœur de l'internationalisation : fonctions pures, sans DOM ni réseau.
 * Utilisable côté navigateur et testable sous Node.
 * @module i18nCore
 */

/** Langues disponibles. Ajouter une langue = l'ajouter ici + créer `locales/<code>.json`. */
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'fr']);

/** Langue native de l'application, utilisée en dernier recours. */
export const DEFAULT_LANGUAGE = 'en';

/** Nom de chaque langue dans sa propre langue (affiché dans le sélecteur, jamais traduit). */
export const LANGUAGE_NAMES = Object.freeze({ en: 'English', fr: 'Français' });

/**
 * @typedef {{ [key: string]: string | Messages }} Messages Arbre de traductions.
 */

/**
 * Ramène une étiquette de langue (« fr-FR », « EN_us ») à une langue supportée, ou null.
 * @param {string | null | undefined} tag
 * @param {readonly string[]} supported
 * @returns {string | null}
 */
export function matchLanguage(tag, supported = SUPPORTED_LANGUAGES) {
  const base = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return base && supported.includes(base) ? base : null;
}

/**
 * Choisit la langue à utiliser.
 * Ordre : choix enregistré de l'utilisateur → langues du navigateur → langue par défaut.
 *
 * @param {object} [options]
 * @param {string | null} [options.stored]          Langue choisie précédemment (localStorage).
 * @param {readonly string[]} [options.browser]     `navigator.languages`.
 * @param {readonly string[]} [options.supported]
 * @param {string} [options.fallback]
 * @returns {string}
 */
export function resolveLanguage({
  stored = null,
  browser = [],
  supported = SUPPORTED_LANGUAGES,
  fallback = DEFAULT_LANGUAGE,
} = {}) {
  const fromStored = matchLanguage(stored, supported);
  if (fromStored) return fromStored;
  for (const tag of browser) {
    const fromBrowser = matchLanguage(tag, supported);
    if (fromBrowser) return fromBrowser;
  }
  return fallback;
}

/**
 * Cherche une clé pointée (« status.ok ») dans un arbre de traductions.
 * @param {Messages} messages
 * @param {string} key
 * @returns {string | Messages | undefined}
 */
export function lookup(messages, key) {
  /** @type {string | Messages | undefined} */
  let node = messages;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Remplace les variables `{nom}` d'un texte.
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function interpolate(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Traduit une clé. Si `params.count` est un nombre, choisit la forme plurielle
 * (`cle.one`, `cle.other`…) selon les règles de la langue (Intl.PluralRules).
 * Repli : langue courante → langue par défaut → la clé elle-même.
 *
 * @param {object} context
 * @param {string} context.language
 * @param {Messages} context.messages          Traductions de la langue courante.
 * @param {Messages} [context.fallbackMessages] Traductions de la langue par défaut.
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function translate({ language, messages, fallbackMessages = {} }, key, params = {}) {
  const keys =
    typeof params.count === 'number'
      ? [`${key}.${new Intl.PluralRules(language).select(params.count)}`, `${key}.other`]
      : [key];

  for (const source of [messages, fallbackMessages]) {
    for (const candidate of keys) {
      const value = lookup(source, candidate);
      if (typeof value === 'string') return interpolate(value, params);
    }
  }
  return key;
}

/**
 * Liste toutes les clés finales d'un arbre (« status.ok », « songs.count.one »…).
 * @param {Messages} messages
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function flattenKeys(messages, prefix = '') {
  return Object.entries(messages).flatMap(([name, value]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    return typeof value === 'string' ? [path] : flattenKeys(value, path);
  });
}
