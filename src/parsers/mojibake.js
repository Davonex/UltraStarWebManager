// @ts-check
/**
 * Texte « mal encodé » (mojibake) : du UTF-8 relu comme du Windows-1252, puis réenregistré.
 * Exemple : « à » (octets C3 A0) devient « Ã » + espace insécable, « é » devient « Ã© »,
 * « ’ » devient « â€™ ». Fonctions pures.
 *
 * Principe : on repère les suites de caractères qui ressemblent à une séquence UTF-8 lue en
 * Windows-1252 (un octet de tête suivi d'octets de continuation 0x80–0xBF), on les
 * réencode en Windows-1252 et on les relit en UTF-8. Pour éviter les faux positifs (texte
 * correct qui ressemblerait par hasard à une séquence), le caractère obtenu doit être un
 * caractère courant : lettre latine accentuée, ponctuation typographique, symbole monétaire…
 *
 * @module parsers/mojibake
 */
import { encodeWindows1252 } from '../utils/windows1252.js';

/**
 * Caractères qui proviennent d'un octet 0x80–0xBF lu en Windows-1252 : les caractères
 * propres à Windows-1252 (€, ’, œ…), les octets non définis (U+0081…) et U+00A0–U+00BF.
 */
const CONTINUATION =
  '[\\u0081\\u008d\\u008f\\u0090\\u009d\\u00a0-\\u00bf€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]';

/**
 * Séquence suspecte : octet de tête 2, 3 ou 4 octets (Â–ß, à–ï, ð–ô en Windows-1252)
 * suivi du bon nombre d'octets de continuation.
 */
const SEQUENCE = new RegExp(
  `[\\u00c2-\\u00df]${CONTINUATION}|[\\u00e0-\\u00ef]${CONTINUATION}{2}|[\\u00f0-\\u00f4]${CONTINUATION}{3}`,
  'g',
);

/** Nombre maximal de passes (texte encodé deux ou trois fois de suite). */
const MAX_PASSES = 3;

/**
 * Caractère plausible dans une chanson : Latin-1 et Latin étendu (é, œ, ß…),
 * ponctuation générale (’ “ ” … – —), symboles monétaires (€) et ™.
 * @param {string} char
 */
function isPlausible(char) {
  const code = /** @type {number} */ (char.codePointAt(0));
  return (code >= 0xa0 && code <= 0x24f) || (code >= 0x2000 && code <= 0x20cf) || code === 0x2122;
}

/**
 * Réinterprète une séquence suspecte ; null si ce n'est pas du mojibake.
 * @param {string} sequence
 * @returns {string | null}
 */
function decodeSequence(sequence) {
  try {
    const char = new TextDecoder('utf-8', { fatal: true }).decode(encodeWindows1252(sequence));
    return isPlausible(char) ? char : null;
  } catch {
    return null;
  }
}

/**
 * Une passe de réparation.
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
function repairOnce(text) {
  let count = 0;
  const repaired = text.replace(SEQUENCE, (sequence) => {
    const char = decodeSequence(sequence);
    if (char === null) return sequence;
    count++;
    return char;
  });
  return { text: repaired, count };
}

/** Ligne de fin « E » : UltraStar ignore tout ce qui suit (parfois des données binaires). */
const END_LINE = /(?:^|\r\n|\r|\n)[ \t]*E/;

/**
 * Sépare la partie utile du fichier (jusqu'à la ligne « E » exclue) de la suite.
 * @param {string} text
 */
function splitAtEnd(text) {
  const match = END_LINE.exec(text);
  const end = match ? match.index : text.length;
  return { body: text.slice(0, end), tail: text.slice(end) };
}

/**
 * Répare un texte mal encodé, jusqu'à la ligne de fin « E ». Le reste du texte (fins de
 * ligne, contenu après « E ») est inchangé.
 * @param {string} text
 * @returns {{ text: string, count: number }}  count : nombre de caractères réparés.
 */
export function repairMojibake(text) {
  const { body, tail } = splitAtEnd(text);
  let current = body;
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { text: repaired, count } = repairOnce(current);
    if (count === 0) break;
    current = repaired;
    total += count;
  }
  return { text: current + tail, count: total };
}

/**
 * Nombre de caractères mal encodés (0 si le texte est correct).
 * @param {string} text
 */
export function countMojibake(text) {
  return repairOnce(splitAtEnd(text).body).count;
}

/**
 * @typedef {object} MojibakeLineChange
 * @property {number} line    Numéro de ligne (à partir de 1).
 * @property {string} before
 * @property {string} after
 */

/**
 * Répare le texte et liste les lignes modifiées (pour l'aperçu avant application).
 * @param {string} text
 * @returns {{ text: string, count: number, changes: MojibakeLineChange[] }}
 */
export function planMojibakeRepair(text) {
  const { text: repaired, count } = repairMojibake(text);
  /** @type {MojibakeLineChange[]} */
  const changes = [];
  if (count > 0) {
    // La réparation ne touche pas aux fins de ligne : les lignes se correspondent une à une.
    const before = text.split(/\r\n|\r|\n/);
    const after = repaired.split(/\r\n|\r|\n/);
    for (const [index, line] of before.entries()) {
      if (line !== after[index])
        changes.push({ line: index + 1, before: line, after: after[index] });
    }
  }
  return { text: repaired, count, changes };
}
