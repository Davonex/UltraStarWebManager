// @ts-check
/**
 * Sélecteur de langue de la barre de navigation.
 * @module languageSelector
 */
import { getLanguage, LANGUAGE_NAMES, SUPPORTED_LANGUAGES, setLanguage } from './i18n.js';

/**
 * Remplit le <select> avec les langues disponibles et branche le changement.
 * @param {HTMLSelectElement} select
 */
export function initLanguageSelector(select) {
  for (const code of SUPPORTED_LANGUAGES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = LANGUAGE_NAMES[/** @type {keyof typeof LANGUAGE_NAMES} */ (code)];
    option.lang = code;
    select.append(option);
  }
  select.value = getLanguage();
  select.addEventListener('change', () => {
    setLanguage(select.value).catch(console.error);
  });
}
