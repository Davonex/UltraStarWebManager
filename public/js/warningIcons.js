// @ts-check
/**
 * Icône (Bootstrap Icons, sprite icons.svg) de chaque type d'avertissement, pour la liste
 * du filtre « Avertissements » et la fenêtre Info. Fonction pure, testée.
 *
 * @module warningIcons
 */

/** Icône par défaut, et celle de « Tous les avertissements ». */
export const DEFAULT_WARNING_ICON = 'exclamation-triangle-fill';

/** Icône par code d'avertissement. */
const ICON_BY_CODE = Object.freeze({
  MISSING_HEADER: 'file-earmark-minus',
  DUPLICATE_HEADER: 'files',
  MALFORMED_HEADER: 'file-earmark-code',
  UNKNOWN_LINE: 'question-square',
  NO_NOTES: 'music-note',
  MISSING_END: 'skip-end',
  ENCODING_NOT_UTF8: 'translate',
  ENCODING_UTF8_BOM: 'translate',
  ENCODING_MOJIBAKE: 'fonts',
  MISSING_FILE: 'file-earmark-x',
  VIDEO_NOT_H264: 'film',
  VIDEO_TOO_LARGE: 'badge-4k',
  VIDEO_IS_AUDIO: 'link-45deg',
  REPLAYGAIN_MISSING: 'soundwave',
  NAMING: 'input-cursor-text',
});

/** En-têtes manquants avec leur propre icône (les mêmes que les filtres Année et Langue). */
const ICON_BY_HEADER = Object.freeze({
  YEAR: 'calendar3',
  LANGUAGE: 'globe2',
});

/**
 * Icône d'un type d'avertissement : code seul (« MISSING_END »), code précisé
 * (« MISSING_HEADER:YEAR ») ou catégorie regroupée (« NAMING », ou un code NAMING_*).
 * @param {string} type
 * @returns {string}  Identifiant du symbole dans icons.svg.
 */
export function warningIcon(type) {
  const [code, param] = type.split(':');
  if (code === 'MISSING_HEADER' && param && param in ICON_BY_HEADER) {
    return ICON_BY_HEADER[/** @type {keyof typeof ICON_BY_HEADER} */ (param)];
  }
  const key = code.startsWith('NAMING_') ? 'NAMING' : code;
  return ICON_BY_CODE[/** @type {keyof typeof ICON_BY_CODE} */ (key)] ?? DEFAULT_WARNING_ICON;
}
