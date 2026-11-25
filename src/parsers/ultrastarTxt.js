// @ts-check
/**
 * Parseur des fichiers chanson UltraStar (.txt).
 *
 * Ce module ne contient que des fonctions pures : aucune lecture disque,
 * aucun état. Il reçoit un Buffer (ou une chaîne) et renvoie un objet.
 * C'est ce qui le rend simple à tester.
 *
 * @module parsers/ultrastarTxt
 */
import { countMojibake } from './mojibake.js';

/**
 * @typedef {object} SongMeta Métadonnées normalisées d'une chanson.
 * @property {string | null} title
 * @property {string | null} artist
 * @property {string | null} audio        Fichier audio (#AUDIO, sinon #MP3).
 * @property {string | null} cover
 * @property {string | null} background
 * @property {string | null} video
 * @property {number | null} videoGap  #VIDEOGAP en secondes (peut être négatif).
 * @property {number | null} year
 * @property {number | null} decade       Ex. 1980 pour 1987.
 * @property {string | null} genre
 * @property {string | null} language
 * @property {string | null} edition
 * @property {string | null} creator
 * @property {number | null} bpm
 * @property {number | null} gap          En millisecondes.
 * @property {number | null} previewStart En secondes.
 * @property {number | null} medleyStartBeat
 * @property {number | null} medleyEndBeat
 * @property {string | null} version      Version du format (#VERSION).
 */

/**
 * @typedef {object} SongStats Statistiques sur le corps du fichier.
 * @property {number} notes     Nombre de notes (: * F R G).
 * @property {number} lineBreaks Nombre de sauts de phrase (-).
 * @property {boolean} isDuet   Présence de P1 / P2.
 * @property {boolean} hasEnd   Présence de la ligne de fin « E ».
 */

/**
 * @typedef {object} ParsedSong
 * @property {SongMeta} meta
 * @property {Record<string, string>} headers Tous les en-têtes bruts (clés en majuscules).
 * @property {SongStats} stats
 * @property {'utf-8' | 'utf-8-bom' | 'windows-1252' | 'string'} encoding Encodage détecté.
 * @property {SongWarning[]} warnings Problèmes détectés (fichier lisible malgré tout).
 */

/**
 * @typedef {object} SongWarning Avertissement sur un fichier chanson.
 * @property {string} code      Identifiant stable (UPPER_SNAKE_CASE), traduisible par l'interface.
 * @property {string} message   Texte anglais lisible (journaux, débogage).
 * @property {Record<string, string | number>} [params] Valeurs variables (en-tête, n° de ligne…).
 */

/**
 * Construit un avertissement.
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string | number>} [params]
 * @returns {SongWarning}
 */
export function songWarning(code, message, params) {
  return params ? { code, message, params } : { code, message };
}

const NOTE_TYPES = new Set([':', '*', 'F', 'R', 'G']);
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/**
 * Décode le contenu brut d'un fichier chanson.
 * Ordre : BOM UTF-8 → UTF-8 strict → repli Windows-1252 (anciens fichiers).
 *
 * @param {Uint8Array} buffer
 * @returns {{ text: string, encoding: 'utf-8' | 'utf-8-bom' | 'windows-1252' }}
 */
export function decodeSongBuffer(buffer) {
  const hasBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  if (hasBom) {
    return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8-bom' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'windows-1252' };
  }
}

/**
 * Convertit une valeur numérique UltraStar (virgule ou point décimal).
 * @param {string | undefined} value
 * @returns {number | null}
 */
export function parseNumber(value) {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrait une année plausible (4 chiffres) d'une valeur #YEAR.
 * @param {string | undefined} value
 * @returns {number | null}
 */
export function parseYear(value) {
  const match = value?.match(/\d{4}/);
  if (!match) return null;
  const year = Number(match[0]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

/**
 * @param {number | null} year
 * @returns {number | null}
 */
export function getDecade(year) {
  return year === null ? null : Math.floor(year / 10) * 10;
}

/**
 * @param {string | undefined} value
 * @returns {string | null}
 */
function textOrNull(value) {
  const v = value?.trim();
  return v ? v : null;
}

/**
 * Convertit un numéro de beat UltraStar en secondes depuis le début de l'audio.
 * Un beat UltraStar dure 60 / (BPM × 4) secondes ; GAP est en millisecondes.
 *
 * @param {number} beat
 * @param {number} bpm
 * @param {number | null} gapMs
 * @returns {number | null} null si le BPM est invalide.
 */
export function beatToSeconds(beat, bpm, gapMs) {
  if (!(bpm > 0)) return null;
  return (gapMs ?? 0) / 1000 + (beat * 60) / (bpm * 4);
}

/**
 * Construit les métadonnées normalisées à partir des en-têtes bruts.
 * @param {Record<string, string>} h
 * @returns {SongMeta}
 */
function buildMeta(h) {
  const year = parseYear(h.YEAR);
  return {
    title: textOrNull(h.TITLE),
    artist: textOrNull(h.ARTIST),
    audio: textOrNull(h.AUDIO) ?? textOrNull(h.MP3),
    cover: textOrNull(h.COVER),
    background: textOrNull(h.BACKGROUND),
    video: textOrNull(h.VIDEO),
    videoGap: parseNumber(h.VIDEOGAP),
    year,
    decade: getDecade(year),
    genre: textOrNull(h.GENRE),
    language: textOrNull(h.LANGUAGE),
    edition: textOrNull(h.EDITION),
    creator: textOrNull(h.CREATOR),
    bpm: parseNumber(h.BPM),
    gap: parseNumber(h.GAP),
    previewStart: parseNumber(h.PREVIEWSTART),
    medleyStartBeat: parseNumber(h.MEDLEYSTARTBEAT),
    medleyEndBeat: parseNumber(h.MEDLEYENDBEAT),
    version: textOrNull(h.VERSION),
  };
}

/**
 * Analyse un fichier chanson UltraStar.
 *
 * @param {Uint8Array | string} input Contenu brut du fichier (Buffer) ou texte déjà décodé.
 * @returns {ParsedSong}
 */
export function parseUltrastarTxt(input) {
  const { text, encoding } =
    typeof input === 'string'
      ? { text: input, encoding: /** @type {const} */ ('string') }
      : decodeSongBuffer(input);

  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {SongStats} */
  const stats = { notes: 0, lineBreaks: 0, isDuet: false, hasEnd: false };
  /** @type {SongWarning[]} */
  const warnings = [];

  const lines = text.split(/\r\n|\r|\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === '') continue;

    const first = line[0];

    if (first === '#') {
      const sep = line.indexOf(':');
      if (sep === -1) {
        warnings.push(
          songWarning('MALFORMED_HEADER', `Line ${index + 1}: header without ":" ignored`, {
            line: index + 1,
          }),
        );
        continue;
      }
      const key = line.slice(1, sep).trim().toUpperCase();
      if (key in headers) {
        warnings.push(
          songWarning('DUPLICATE_HEADER', `Duplicate #${key} header (last value kept)`, {
            header: key,
          }),
        );
      }
      headers[key] = line.slice(sep + 1).trim();
      continue;
    }

    if (first === 'E') {
      stats.hasEnd = true;
      break; // Tout ce qui suit « E » est ignoré par UltraStar.
    }

    if (NOTE_TYPES.has(first)) stats.notes++;
    else if (first === '-') stats.lineBreaks++;
    else if (first === 'P') stats.isDuet = true;
    else {
      warnings.push(
        songWarning('UNKNOWN_LINE', `Line ${index + 1}: unrecognized line`, { line: index + 1 }),
      );
    }
  }

  const meta = buildMeta(headers);

  /** @param {string} header */
  const missing = (header) =>
    songWarning('MISSING_HEADER', `Missing or invalid #${header} header`, { header });

  if (!meta.title) warnings.push(missing('TITLE'));
  if (!meta.artist) warnings.push(missing('ARTIST'));
  if (!meta.audio) warnings.push(missing('AUDIO'));
  if (meta.bpm === null) warnings.push(missing('BPM'));
  // Facultatifs dans le format, mais utiles au catalogue (filtres Langue et Décennie).
  if (meta.year === null) warnings.push(missing('YEAR'));
  if (!meta.language?.trim()) warnings.push(missing('LANGUAGE'));
  if (stats.notes === 0) warnings.push(songWarning('NO_NOTES', 'No notes found'));
  if (!stats.hasEnd) warnings.push(songWarning('MISSING_END', 'Missing end line "E"'));
  // Format 1.1.0 : UTF-8 sans BOM obligatoire.
  if (encoding === 'windows-1252') {
    warnings.push(
      songWarning('ENCODING_NOT_UTF8', 'Encoding is Windows-1252: UTF-8 without BOM expected', {
        encoding,
      }),
    );
  } else if (encoding === 'utf-8-bom') {
    warnings.push(songWarning('ENCODING_UTF8_BOM', 'UTF-8 with BOM: UTF-8 without BOM expected'));
  }
  // Texte UTF-8 relu en Windows-1252 puis réenregistré (« Ã© » au lieu de « é »).
  if (countMojibake(text) > 0) {
    warnings.push(
      songWarning('ENCODING_MOJIBAKE', 'Garbled characters (e.g. "Ã©" instead of "é")'),
    );
  }

  return { meta, headers, stats, encoding, warnings };
}
