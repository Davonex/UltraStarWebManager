// @ts-check
/**
 * Modification des en-têtes d'un fichier chanson UltraStar — fonctions pures.
 *
 * Principe : on ne touche **qu'aux lignes d'en-tête concernées**. Tout le reste du fichier
 * (notes, autres en-têtes, fins de ligne CRLF/LF, ligne finale) reste identique.
 *
 * @module parsers/ultrastarEdit
 */
import { encodeWindows1252 } from '../utils/windows1252.js';

/**
 * @typedef {object} HeaderChange Changement d'un en-tête.
 * @property {string} header         Nom en majuscules (ex. « EDITION »).
 * @property {string | null} before  Valeur actuelle (null = absent).
 * @property {string | null} after   Nouvelle valeur (null = supprimé).
 */

/**
 * Nom (en majuscules) et valeur d'une ligne d'en-tête, ou null si ce n'en est pas une.
 * @param {string} line
 * @returns {{ key: string, value: string } | null}
 */
function headerOf(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('#')) return null;
  const sep = trimmed.indexOf(':');
  if (sep === -1) return null;
  return { key: trimmed.slice(1, sep).trim().toUpperCase(), value: trimmed.slice(sep + 1).trim() };
}

/**
 * Modifie des en-têtes dans le texte d'un fichier chanson.
 *
 * - En-tête présent : sa ligne est remplacée (le nom garde sa casse d'origine, ex. `#Edition`).
 *   Des doublons éventuels du même en-tête sont supprimés.
 * - En-tête absent : il est ajouté à la fin du bloc d'en-têtes (avant la première note).
 * - Valeur null : l'en-tête est supprimé.
 * - Valeur identique : rien ne change.
 *
 * @param {string} text  Contenu décodé du fichier.
 * @param {Record<string, string | null>} values  Nouvelles valeurs, clés en majuscules.
 * @returns {{ text: string, changes: HeaderChange[] }}
 */
export function updateHeaders(text, values) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  /** @type {Map<string, string>} */
  const current = new Map();
  let headerEnd = 0; // index de la ligne qui suit le dernier en-tête

  for (const [index, line] of lines.entries()) {
    const header = headerOf(line);
    if (header) {
      if (!current.has(header.key)) current.set(header.key, header.value);
      headerEnd = index + 1;
    } else if (line.trim() !== '') {
      break; // fin du bloc d'en-têtes
    }
  }

  /** @type {HeaderChange[]} */
  const changes = [];
  for (const [key, after] of Object.entries(values)) {
    const before = current.get(key) ?? null;
    if (before !== after) changes.push({ header: key, before, after });
  }
  if (changes.length === 0) return { text, changes };

  const pending = new Map(changes.map((c) => [c.header, c.after]));
  const written = new Set();
  /** @type {string[]} */
  const result = [];
  for (const [index, line] of lines.entries()) {
    const header = index < headerEnd ? headerOf(line) : null;
    if (header && pending.has(header.key)) {
      const after = pending.get(header.key);
      if (after !== null && !written.has(header.key)) {
        const name = line.trim().slice(1, line.trim().indexOf(':')); // casse d'origine
        result.push(`#${name}:${after}`);
      }
      written.add(header.key);
      continue;
    }
    if (index === headerEnd) {
      // En-têtes absents : ajoutés à la fin du bloc d'en-têtes.
      for (const [key, after] of pending) {
        if (!written.has(key) && after !== null) result.push(`#${key}:${after}`);
        written.add(key);
      }
    }
    result.push(line);
  }
  // Fichier sans corps ni ligne vide finale : en-têtes ajoutés à la fin.
  for (const [key, after] of pending) {
    if (!written.has(key) && after !== null) result.push(`#${key}:${after}`);
  }
  return { text: result.join(eol), changes };
}

/**
 * Ré-encode le texte d'un fichier dans son encodage d'origine.
 * @param {string} text
 * @param {'utf-8' | 'utf-8-bom' | 'windows-1252' | 'string'} encoding
 * @returns {Buffer}
 * @throws {import('../utils/windows1252.js').UnencodableCharacterError}
 */
export function encodeSongText(text, encoding) {
  if (encoding === 'windows-1252') return encodeWindows1252(text);
  const utf8 = Buffer.from(text, 'utf8');
  return encoding === 'utf-8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]) : utf8;
}
