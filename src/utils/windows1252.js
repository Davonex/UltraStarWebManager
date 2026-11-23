// @ts-check
/**
 * Encodage Windows-1252 (CP1252), utilisé par beaucoup d'anciens fichiers UltraStar.
 * Node sait le décoder (TextDecoder) mais pas l'encoder : ce module le fait.
 *
 * Windows-1252 = Latin-1, sauf la plage 0x80–0x9F qui contient des caractères
 * typographiques (€, ’, “, ”, œ, …).
 *
 * @module utils/windows1252
 */

/** Caractères de la plage 0x80–0x9F propres à Windows-1252. */
const SPECIAL = Object.freeze({
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
});

/** Octets non définis en Windows-1252 : le décodeur les rend tels quels (U+0081…). */
const UNDEFINED_BYTES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** Erreur : un caractère n'existe pas en Windows-1252. */
export class UnencodableCharacterError extends Error {
  /** @param {string} character */
  constructor(character) {
    super(`Character "${character}" cannot be written in Windows-1252`);
    this.name = 'UnencodableCharacterError';
    this.character = character;
  }
}

/**
 * Encode un texte en Windows-1252.
 * @param {string} text
 * @returns {Buffer}
 * @throws {UnencodableCharacterError} si un caractère n'existe pas dans cet encodage.
 */
export function encodeWindows1252(text) {
  const bytes = [];
  for (const char of text) {
    const code = /** @type {number} */ (char.codePointAt(0));
    const special = SPECIAL[/** @type {keyof typeof SPECIAL} */ (char)];
    if (special !== undefined) bytes.push(special);
    else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (UNDEFINED_BYTES.has(code)) bytes.push(code);
    else throw new UnencodableCharacterError(char);
  }
  return Buffer.from(bytes);
}
