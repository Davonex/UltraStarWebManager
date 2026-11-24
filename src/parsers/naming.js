// @ts-check
/**
 * Nommage des dossiers et fichiers d'une chanson. FONCTIONS PURES.
 *
 * Chaque élément suit un **modèle** réglable dans les préférences, où `{artist}` et `{title}`
 * sont remplacés par #ARTIST et #TITLE. Valeurs par défaut (format 1.1.0 usdx.eu + convention
 * de la communauté, ex. Karedi) :
 *
 * | Élément       | Modèle par défaut              | Source                             |
 * | ------------- | ------------------------------ | ---------------------------------- |
 * | dossier       | `{artist} - {title}`           | convention                         |
 * | .txt          | `{artist} - {title}`           | convention                         |
 * | .txt d'un duo | `{artist} - {title} [DUET]`    | convention (choix du projet)       |
 * | audio         | `{artist} - {title}`           | norme : même nom que le dossier    |
 * | vidéo         | `{artist} - {title}`           | convention                         |
 * | pochette      | `{artist} - {title} [CO]`      | norme : « should end with [CO] »   |
 * | fond          | `{artist} - {title} [BG]`      | norme : « [BG] »                   |
 * | voix seule    | `{artist} - {title} [VOC]`     | norme : « please add [VOC] »       |
 * | instrumental  | `{artist} - {title} [INSTR]`   | norme : « please add [INSTR] »     |
 *
 * L'extension n'est jamais vérifiée. Comparaison souple : majuscules, accents et espaces en
 * trop sont ignorés ; un caractère interdit par Windows (`\ / : * ? " < > |`) peut être retiré
 * ou remplacé par un tiret, une espace ou un « _ » (« AC/DC » → « AC-DC » ou « ACDC ») ; une
 * marque de duo en fin de titre (« [DUET] », « (Duet) », « - DUO ») est ignorée.
 *
 * @module parsers/naming
 */

/** Caractères interdits dans un nom de fichier Windows. */
const FORBIDDEN = /[\\/:*?"<>|]/g;
const FORBIDDEN_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
/** Variables utilisables dans un modèle. */
const PLACEHOLDERS = /\{(artist|title)\}/g;
const MAX_PATTERN_LENGTH = 200;

/**
 * Éléments vérifiés, dans l'ordre d'affichage des préférences.
 * @type {readonly NamingKind[]}
 */
export const NAMING_KINDS = Object.freeze([
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
 * @typedef {'folder' | 'txt' | 'duet' | 'audio' | 'video' | 'cover' | 'background' | 'vocals' | 'instrumental'} NamingKind
 * @typedef {{ enabled: boolean, pattern: string }} NamingRule
 * @typedef {Record<NamingKind, NamingRule>} NamingRules
 */

/** @type {Readonly<NamingRules>} */
export const DEFAULT_NAMING = Object.freeze({
  folder: { enabled: true, pattern: '{artist} - {title}' },
  txt: { enabled: true, pattern: '{artist} - {title}' },
  duet: { enabled: true, pattern: '{artist} - {title} [DUET]' },
  audio: { enabled: true, pattern: '{artist} - {title}' },
  video: { enabled: true, pattern: '{artist} - {title}' },
  cover: { enabled: true, pattern: '{artist} - {title} [CO]' },
  background: { enabled: true, pattern: '{artist} - {title} [BG]' },
  vocals: { enabled: true, pattern: '{artist} - {title} [VOC]' },
  instrumental: { enabled: true, pattern: '{artist} - {title} [INSTR]' },
});

/** Code d'avertissement de chaque élément (le .txt d'un duo est un « TXT »). */
const WARNING_KINDS = Object.freeze({
  folder: 'FOLDER',
  txt: 'TXT',
  duet: 'TXT',
  audio: 'AUDIO',
  video: 'VIDEO',
  cover: 'COVER',
  background: 'BACKGROUND',
  vocals: 'VOCALS',
  instrumental: 'INSTRUMENTAL',
});

/**
 * @typedef {object} NamingProblem
 * @property {'FOLDER' | 'TXT' | 'AUDIO' | 'VIDEO' | 'COVER' | 'BACKGROUND' | 'VOCALS' | 'INSTRUMENTAL'} kind
 * @property {string} actual    Nom actuel.
 * @property {string} expected  Nom attendu (avec l'extension actuelle).
 */

/**
 * Erreur dans un modèle saisi (message en anglais, `code` traduisible côté interface).
 * @param {unknown} pattern
 * @returns {'PATTERN_EMPTY' | 'PATTERN_TOO_LONG' | 'PATTERN_NO_PLACEHOLDER' | 'PATTERN_UNKNOWN_PLACEHOLDER' | 'PATTERN_FORBIDDEN_CHARACTER' | null}
 */
export function patternError(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') return 'PATTERN_EMPTY';
  if (pattern.length > MAX_PATTERN_LENGTH) return 'PATTERN_TOO_LONG';
  // Expressions sans « g » : .test() sur une expression globale garde une position entre appels.
  if (!/\{(artist|title)\}/.test(pattern)) return 'PATTERN_NO_PLACEHOLDER';
  const rest = pattern.replace(PLACEHOLDERS, '');
  if (/[{}]/.test(rest)) return 'PATTERN_UNKNOWN_PLACEHOLDER';
  if (/[\\/:*?"<>|]/.test(rest)) return 'PATTERN_FORBIDDEN_CHARACTER';
  return null;
}

/**
 * Clé de comparaison souple d'un nom.
 * @param {string} name
 */
export function namingKey(name) {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[ .]+$/, '') // Windows retire les espaces et points finaux
    .trim()
    .toLocaleLowerCase();
}

/** Marque de duo en fin de titre (« Tonight [DUET] », « … (Duet) », « … - DUO »). */
const DUET_MARK = /\s*(?:[[(]\s*du(?:et|o)\s*[\])]|-\s*du(?:et|o))\s*$/i;

/**
 * Titre sans marque de duo : le dossier et les médias sont partagés avec la version solo,
 * seul le .txt du duo porte « [DUET] ».
 * @param {string} title
 */
export function titleWithoutDuetMark(title) {
  return title.replace(DUET_MARK, '');
}

/**
 * Remplit un modèle (sans adapter les caractères interdits).
 * @param {string} pattern
 * @param {string} artist
 * @param {string} title
 */
function fill(pattern, artist, title) {
  return pattern.replace(PLACEHOLDERS, (_, name) =>
    name === 'artist' ? artist.trim() : title.trim(),
  );
}

/**
 * Nom attendu, prêt à servir de nom de fichier : « / » et « \ » remplacés par un tiret, les
 * autres caractères interdits par Windows retirés.
 * @param {string} pattern
 * @param {string} artist
 * @param {string} title
 */
export function expectedName(pattern, artist, title) {
  return fill(pattern, artist, title)
    .replace(/[\\/]/g, '-')
    .replace(FORBIDDEN, '')
    .replace(/\s+/g, ' ');
}

/**
 * Le nom (sans extension) suit-il le modèle ? Chaque caractère interdit du nom attendu peut
 * avoir été retiré, ou remplacé par « - », « _ » ou une espace.
 * @param {string} stem
 * @param {string} pattern
 * @param {string} artist
 * @param {string} title
 */
export function matchesPattern(stem, pattern, artist, title) {
  const expected = namingKey(fill(pattern, artist, title));
  let regex = '';
  for (const char of expected) {
    if (FORBIDDEN_CHARS.has(char))
      regex += '[-_ ]?'; // retiré ou remplacé
    else if (char === ' ')
      regex += ' *'; // espace éventuellement retirée
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // caractère tel quel
  }
  return new RegExp(`^${regex}$`).test(namingKey(stem));
}

/** @param {string} file */
function splitName(file) {
  const dot = file.lastIndexOf('.');
  return dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
}

/**
 * Noms qui ne suivent pas les modèles.
 *
 * @param {object} song
 * @param {string | null} song.artist
 * @param {string | null} song.title
 * @param {string} song.folderName  Dernier dossier ('' : chanson à la racine, non vérifié).
 * @param {string} song.txtFile
 * @param {boolean} song.isDuet
 * @param {Partial<Record<'audio' | 'video' | 'cover' | 'background' | 'vocals' | 'instrumental', string | null>>} song.files
 *   Noms des fichiers (absent ou null : non vérifié).
 * @param {NamingRules} [rules]  Modèles (préférences) ; par défaut DEFAULT_NAMING.
 * @returns {NamingProblem[]}
 */
export function checkNaming(
  { artist, title, folderName, txtFile, isDuet, files },
  rules = DEFAULT_NAMING,
) {
  if (!artist?.trim() || !title?.trim()) return []; // déjà signalé (en-tête manquant)
  const cleanTitle = titleWithoutDuetMark(title);
  /** @type {NamingProblem[]} */
  const problems = [];

  /**
   * @param {NamingKind} kind
   * @param {string | null | undefined} name
   * @param {boolean} hasExtension
   */
  const check = (kind, name, hasExtension) => {
    const rule = rules[kind];
    if (!name || !rule?.enabled) return;
    const [stem, extension] = hasExtension ? splitName(name) : [name, ''];
    if (!matchesPattern(stem, rule.pattern, artist, cleanTitle)) {
      problems.push({
        kind: WARNING_KINDS[kind],
        actual: name,
        expected: `${expectedName(rule.pattern, artist, cleanTitle)}${extension}`,
      });
    }
  };

  check('folder', folderName, false);
  check(isDuet ? 'duet' : 'txt', txtFile, true);
  check('audio', files.audio, true);
  // Vidéo qui sert aussi de musique : déjà vérifiée comme audio.
  if (files.video !== files.audio) check('video', files.video, true);
  check('cover', files.cover, true);
  check('background', files.background, true);
  check('vocals', files.vocals, true);
  check('instrumental', files.instrumental, true);
  return problems;
}
