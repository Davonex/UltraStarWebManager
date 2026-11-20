// @ts-check
/**
 * Petits utilitaires de texte.
 * @module utils/text
 */

/**
 * Découpe une valeur multiple UltraStar (« Pop, Rock ») en liste propre.
 * @param {string | null | undefined} value
 * @returns {string[]}
 */
export function splitList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Clé de comparaison « souple » : insensible à la casse, aux accents et aux espaces superflus.
 * Ex. « Kölsch », « kolsch » et « KOLSCH » donnent la même clé.
 * @param {string} text
 * @returns {string}
 */
export function looseKey(text) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clé de comparaison de noms de fichiers : insensible à la casse (comme Windows)
 * et à la forme Unicode des accents (é composé ou décomposé).
 * @param {string} name
 * @returns {string}
 */
export function fileNameKey(name) {
  return name.normalize('NFC').toLowerCase();
}
