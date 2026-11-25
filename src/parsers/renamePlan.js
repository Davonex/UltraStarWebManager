// @ts-check
/**
 * Plan de renommage d'un dossier de chanson selon les normes de nommage. FONCTIONS PURES.
 *
 * Le renommage se fait au niveau du **dossier** : tous ses .txt (classique, duo, versions…)
 * partagent souvent la même musique, vidéo ou pochette. Renommer un fichier oblige donc à
 * corriger chaque .txt qui le cite.
 *
 * Le plan liste :
 * - le dossier et chaque fichier, avec le nom actuel, le nom proposé (modèles des préférences)
 *   et le nom final (proposé, ou saisi par l'utilisateur) ;
 * - les fichiers non cités par un .txt (sauvegardes, paroles…) : aucun nom proposé, mais ils
 *   peuvent être renommés à la main (aucun .txt à corriger) ;
 * - pour chaque .txt, les en-têtes modifiés (#MP3, #VIDEO, #COVER…) et son nouveau nom ;
 *   #BACKGROUND est retiré quand il désigne la pochette et qu'il n'y a pas d'autre image ;
 * - les conflits (nom invalide, doublon, extension changée) qui bloquent l'application.
 *
 * @module parsers/renamePlan
 */
import { fileNameKey } from '../utils/text.js';
import {
  DEFAULT_NAMING,
  expectedName,
  isRedundantBackground,
  matchesPattern,
  titleWithoutDuetMark,
} from './naming.js';
import { updateHeaders } from './ultrastarEdit.js';

/** En-têtes qui citent un fichier, avec le modèle de nommage à appliquer. */
const FILE_HEADERS = Object.freeze({
  AUDIO: 'audio',
  MP3: 'audio',
  VIDEO: 'video',
  COVER: 'cover',
  BACKGROUND: 'background',
  VOCALS: 'vocals',
  INSTRUMENTAL: 'instrumental',
});

/** Ordre d'affichage des éléments. */
const KIND_ORDER = Object.freeze([
  'folder',
  'txt',
  'duet',
  'audio',
  'video',
  'cover',
  'background',
  'vocals',
  'instrumental',
  'other',
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: caractères de contrôle interdits par Windows
const FORBIDDEN_IN_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
/** Noms réservés par Windows (avec ou sans extension). */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME_LENGTH = 200;

/**
 * @typedef {import('./naming.js').NamingKind | 'folder' | 'other'} RenameKind
 *
 * @typedef {'EMPTY' | 'FORBIDDEN_CHARACTER' | 'TRAILING_DOT_OR_SPACE' | 'RESERVED_NAME'
 *   | 'TOO_LONG' | 'EXTENSION_CHANGED' | 'DUPLICATE' | 'EXISTS'} RenameError
 *
 * @typedef {object} RenameEntry
 * @property {RenameKind} kind
 * @property {string} from       Nom actuel.
 * @property {string} proposed   Nom selon la norme (= from s'il est conforme ou sans règle).
 * @property {string} to         Nom final : proposé, ou saisi par l'utilisateur.
 * @property {'unchanged' | 'rename'} action
 * @property {RenameError | null} error
 * @property {string[]} usedBy   Fichiers .txt qui le citent.
 *
 * @typedef {object} RenameTxtInput Un .txt du dossier, déjà décodé.
 * @property {string} txtFile
 * @property {string} text
 * @property {Record<string, string>} headers  En-têtes bruts, clés en majuscules.
 * @property {boolean} isDuet
 *
 * @typedef {object} RenameTxtResult
 * @property {string} txtFile
 * @property {string} newTxtFile
 * @property {import('./ultrastarEdit.js').HeaderChange[]} changes  En-têtes modifiés.
 * @property {string} text  Nouveau contenu (identique s'il n'y a aucun changement).
 *
 * @typedef {object} RenamePlan
 * @property {string | null} artist   Artiste et titre utilisés (null : impossible à déterminer).
 * @property {string | null} title
 * @property {RenameEntry | null} folder  null : chanson à la racine (dossier non renommé).
 * @property {RenameEntry[]} files
 * @property {RenameTxtResult[]} txts
 * @property {number} renameCount   Dossier et fichiers renommés.
 * @property {number} txtChangeCount  .txt dont le contenu change (en-têtes).
 * @property {number} errorCount
 */

/** @param {string} name */
function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/**
 * Erreur d'un nom de fichier ou de dossier saisi (null s'il est valide).
 * @param {string} name
 * @returns {RenameError | null}
 */
export function nameError(name) {
  if (name === '') return 'EMPTY';
  if (FORBIDDEN_IN_NAME.test(name)) return 'FORBIDDEN_CHARACTER';
  if (/[ .]$/.test(name) || name === '.' || name === '..') return 'TRAILING_DOT_OR_SPACE';
  if (RESERVED_NAMES.test(name)) return 'RESERVED_NAME';
  if (name.length > MAX_NAME_LENGTH) return 'TOO_LONG';
  return null;
}

/**
 * Artiste et titre de référence du dossier : ceux de la version classique en priorité
 * (le titre d'un duo peut porter « [DUET] »).
 * @param {RenameTxtInput[]} txts
 */
function songIdentity(txts) {
  const sorted = [...txts].sort((a, b) => Number(a.isDuet) - Number(b.isDuet));
  for (const { headers } of sorted) {
    const artist = headers.ARTIST?.trim();
    const title = headers.TITLE?.trim();
    if (artist && title) return { artist, title: titleWithoutDuetMark(title) };
  }
  return null;
}

/**
 * Construit le plan de renommage d'un dossier.
 *
 * @param {object} input
 * @param {string} input.folderName  Nom du dossier ('' : racine de la bibliothèque, non renommée).
 * @param {string[]} input.fileNames  Tous les fichiers du dossier.
 * @param {RenameTxtInput[]} input.txts
 * @param {import('./naming.js').NamingRules} [input.rules]
 * @param {{ folder?: string, files?: Record<string, string> }} [input.overrides]
 *   Noms saisis par l'utilisateur (clé : nom actuel).
 * @returns {RenamePlan}
 */
export function buildRenamePlan({
  folderName,
  fileNames,
  txts,
  rules = DEFAULT_NAMING,
  overrides = {},
}) {
  const identity = songIdentity(txts);
  const visible = fileNames.filter((name) => !name.startsWith('.'));
  const filesByKey = new Map(visible.map((name) => [fileNameKey(name), name]));

  /**
   * Nom proposé pour un élément : inchangé s'il suit déjà le modèle (ou sans règle active).
   * @param {import('./naming.js').NamingKind} kind
   * @param {string} name
   * @param {boolean} hasExtension
   */
  const propose = (kind, name, hasExtension) => {
    const rule = rules[kind];
    if (!identity || !rule?.enabled) return name;
    const [stem, extension] = hasExtension ? splitExtension(name) : [name, ''];
    if (matchesPattern(stem, rule.pattern, identity.artist, identity.title)) return name;
    return `${expectedName(rule.pattern, identity.artist, identity.title).trim()}${extension}`;
  };

  /** @type {Map<string, RenameEntry>} clé : nom actuel (insensible à la casse) */
  const entries = new Map();
  /**
   * @param {RenameKind} kind
   * @param {string} from
   * @param {string} proposed
   * @param {string} [usedBy]
   */
  const addEntry = (kind, from, proposed, usedBy) => {
    const key = fileNameKey(from);
    const existing = entries.get(key);
    if (existing) {
      if (usedBy && !existing.usedBy.includes(usedBy)) existing.usedBy.push(usedBy);
      return;
    }
    entries.set(key, {
      kind,
      from,
      proposed,
      to: proposed,
      action: 'unchanged',
      error: null,
      usedBy: usedBy ? [usedBy] : [],
    });
  };

  // 1. Les .txt, puis les fichiers qu'ils citent (la musique avant la vidéo : une vidéo qui
  //    sert aussi de musique suit le modèle audio, comme pour les avertissements).
  for (const txt of txts) {
    const kind = txt.isDuet ? 'duet' : 'txt';
    addEntry(kind, txt.txtFile, propose(kind, txt.txtFile, true), txt.txtFile);
  }
  for (const txt of txts) {
    for (const [header, kind] of Object.entries(FILE_HEADERS)) {
      const reference = txt.headers[header];
      const actual = reference ? filesByKey.get(fileNameKey(reference.trim())) : undefined;
      if (!actual) continue; // absent : déjà signalé par un autre avertissement
      const namingKind = /** @type {import('./naming.js').NamingKind} */ (kind);
      addEntry(namingKind, actual, propose(namingKind, actual, true), txt.txtFile);
    }
  }
  // 2. Les autres fichiers : aucun nom proposé, renommables à la main.
  for (const name of visible) {
    if (!entries.has(fileNameKey(name))) {
      entries.set(fileNameKey(name), {
        kind: 'other',
        from: name,
        proposed: name,
        to: name,
        action: 'unchanged',
        error: null,
        usedBy: [],
      });
    }
  }

  // 3. Noms saisis, puis vérifications.
  const files = [...entries.values()];
  for (const entry of files) {
    const typed = overrides.files?.[entry.from];
    entry.to = (typeof typed === 'string' ? typed : entry.proposed).trim();
    entry.action = entry.to === entry.from ? 'unchanged' : 'rename';
    if (entry.action === 'unchanged') continue;
    entry.error = nameError(entry.to);
    const sameExtension =
      splitExtension(entry.to)[1].toLowerCase() === splitExtension(entry.from)[1].toLowerCase();
    if (!entry.error && !sameExtension) entry.error = 'EXTENSION_CHANGED';
  }
  // Deux fichiers ne peuvent pas finir avec le même nom (Windows ignore la casse).
  /** @type {Map<string, RenameEntry[]>} */
  const byTarget = new Map();
  for (const entry of files) {
    const key = fileNameKey(entry.to);
    byTarget.set(key, [...(byTarget.get(key) ?? []), entry]);
  }
  for (const group of byTarget.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      if (entry.action === 'rename' && !entry.error) entry.error = 'DUPLICATE';
    }
  }

  /** @type {RenameEntry | null} */
  let folder = null;
  if (folderName !== '') {
    const proposed = propose('folder', folderName, false);
    const typed = overrides.folder;
    const to = (typeof typed === 'string' ? typed : proposed).trim();
    const action = to === folderName ? 'unchanged' : 'rename';
    folder = {
      kind: 'folder',
      from: folderName,
      proposed,
      to,
      action,
      error: action === 'rename' ? nameError(to) : null,
      usedBy: txts.map((t) => t.txtFile),
    };
  }

  // 4. Effet sur chaque .txt : nouveau nom et en-têtes qui citent un fichier renommé.
  const renamed = new Map(
    files.filter((e) => e.action === 'rename').map((e) => [fileNameKey(e.from), e.to]),
  );
  /** @param {Record<string, string>} headers @param {string} header */
  const actualFile = (headers, header) => {
    const reference = headers[header];
    return reference ? filesByKey.get(fileNameKey(reference.trim())) : undefined;
  };
  const txtResults = txts.map((txt) => {
    /** @type {Record<string, string | null>} */
    const values = {};
    for (const header of Object.keys(FILE_HEADERS)) {
      const actual = actualFile(txt.headers, header);
      const target = actual ? renamed.get(fileNameKey(actual)) : undefined;
      if (target) values[header] = target;
    }
    // Fond = pochette, sans autre image : l'entrée #BACKGROUND est retirée (pochette prioritaire).
    if (
      rules.background?.enabled &&
      isRedundantBackground(
        actualFile(txt.headers, 'COVER'),
        actualFile(txt.headers, 'BACKGROUND'),
        visible,
      )
    ) {
      values.BACKGROUND = null;
    }
    const { text, changes } = updateHeaders(txt.text, values);
    return {
      txtFile: txt.txtFile,
      newTxtFile: renamed.get(fileNameKey(txt.txtFile)) ?? txt.txtFile,
      changes,
      text,
    };
  });

  files.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.from.localeCompare(b.from),
  );
  const all = folder ? [folder, ...files] : files;
  return {
    artist: identity?.artist ?? null,
    title: identity?.title ?? null,
    folder,
    files,
    txts: txtResults,
    renameCount: all.filter((e) => e.action === 'rename').length,
    txtChangeCount: txtResults.filter((t) => t.changes.length > 0).length,
    errorCount: all.filter((e) => e.error !== null).length,
  };
}
