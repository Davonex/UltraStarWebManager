// @ts-check
/**
 * Catalogue des chansons : parcourt SONG_DIR, lit chaque fichier .txt UltraStar
 * et garde en mémoire la liste des chansons.
 *
 * Lecture seule : ce service ne modifie jamais la bibliothèque.
 *
 * @module services/catalogService
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { beatToSeconds, parseUltrastarTxt, songWarning } from '../parsers/ultrastarTxt.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { resolveInside } from '../utils/safePath.js';
import { fileNameKey, splitList } from '../utils/text.js';

/** Nombre de fichiers lus en parallèle. */
const READ_CONCURRENCY = 16;
/** Profondeur maximale de sous-dossiers explorés. */
const MAX_DEPTH = 8;
/** Longueur de l'identifiant (hexadécimal) d'une chanson. */
const ID_LENGTH = 12;
const COVER_MARKER = '[co]';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * @typedef {object} SongFiles Noms réels des fichiers trouvés dans le dossier (null si absent).
 * @property {string | null} audio
 * @property {string | null} cover
 * @property {string | null} background
 * @property {string | null} video
 */

/**
 * @typedef {object} Song
 * @property {string} id              Identifiant stable (empreinte du chemin relatif).
 * @property {string} folder          Dossier relatif à SONG_DIR, séparateur « / ».
 * @property {string} txtFile         Nom du fichier .txt.
 * @property {string | null} title
 * @property {string | null} artist
 * @property {number | null} year
 * @property {number | null} decade
 * @property {string[]} genres
 * @property {string[]} languages
 * @property {string[]} editions
 * @property {string[]} creators
 * @property {string[]} tags
 * @property {boolean} isDuet
 * @property {number | null} previewStart  Début de la preview en secondes (null = au choix du lecteur).
 * @property {'tag' | 'medley' | null} previewSource  #PREVIEWSTART, ou début du medley.
 * @property {string | null} formatVersion #VERSION, null = ancien format.
 * @property {SongFiles} files
 * @property {boolean} coverGuessed  Pochette trouvée par le marqueur [CO] et non par #COVER.
 * @property {string} encoding
 * @property {import('../parsers/ultrastarTxt.js').SongWarning[]} warnings
 * @property {number} modifiedAt      Date de modification du .txt (ms).
 */

/**
 * @typedef {object} CatalogStatus
 * @property {'not-configured' | 'empty' | 'loading' | 'ready' | 'error'} state
 * @property {number} count
 * @property {string | null} scannedAt     Date ISO du dernier scan réussi.
 * @property {number | null} durationMs
 * @property {{ path: string, reason: string }[]} skipped  Fichiers .txt ignorés (pas UltraStar).
 * @property {{ path: string, message: string }[]} errors   Fichiers illisibles.
 * @property {string | null} error         Erreur bloquante (dossier introuvable…).
 */

/**
 * @typedef {object} SongDirectory Dossier contenant au moins un .txt.
 * @property {string} relativeDir
 * @property {string[]} fileNames
 */

/**
 * Parcourt récursivement `root` et renvoie les dossiers contenant des .txt.
 * Les dossiers et fichiers cachés (commençant par « . ») sont ignorés.
 *
 * @param {string} root
 * @returns {Promise<SongDirectory[]>}
 */
async function findSongDirectories(root) {
  /** @type {SongDirectory[]} */
  const found = [];

  /**
   * @param {string} relativeDir
   * @param {number} depth
   */
  async function walk(relativeDir, depth) {
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    const visible = entries.filter((entry) => !entry.name.startsWith('.'));
    const fileNames = visible.filter((entry) => entry.isFile()).map((entry) => entry.name);

    if (fileNames.some((name) => path.extname(name).toLowerCase() === '.txt')) {
      found.push({ relativeDir, fileNames });
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of visible.filter((e) => e.isDirectory())) {
      await walk(path.join(relativeDir, entry.name), depth + 1);
    }
  }

  await walk('', 0);
  return found;
}

/**
 * Retrouve le nom réel d'un fichier référencé, sans tenir compte de la casse ni des accents
 * composés/décomposés.
 *
 * @param {Map<string, string>} filesByKey
 * @param {string | null} reference
 * @returns {string | null}
 */
function findFile(filesByKey, reference) {
  if (!reference) return null;
  return filesByKey.get(fileNameKey(reference)) ?? null;
}

/**
 * Cherche une pochette nommée avec le marqueur [CO] quand #COVER est absent ou introuvable.
 * @param {string[]} fileNames
 * @returns {string | null}
 */
function guessCover(fileNames) {
  return (
    fileNames.find(
      (name) =>
        fileNameKey(name).includes(COVER_MARKER) &&
        IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()),
    ) ?? null
  );
}

/**
 * Identifiant stable d'une chanson à partir de son chemin relatif.
 * @param {string} relativePath
 * @returns {string}
 */
export function songId(relativePath) {
  return createHash('sha1')
    .update(fileNameKey(relativePath.split(path.sep).join('/')))
    .digest('hex')
    .slice(0, ID_LENGTH);
}

/**
 * Construit l'objet Song à partir d'un fichier analysé.
 *
 * @param {object} input
 * @param {string} input.relativeDir
 * @param {string} input.txtFile
 * @param {string[]} input.fileNames
 * @param {import('../parsers/ultrastarTxt.js').ParsedSong} input.parsed
 * @param {number} input.modifiedAt
 * @returns {Song}
 */
export function buildSong({ relativeDir, txtFile, fileNames, parsed, modifiedAt }) {
  const { meta, stats, encoding } = parsed;
  const filesByKey = new Map(fileNames.map((name) => [fileNameKey(name), name]));
  const warnings = [...parsed.warnings];

  /** @type {SongFiles} */
  const files = {
    audio: findFile(filesByKey, meta.audio),
    cover: findFile(filesByKey, meta.cover),
    background: findFile(filesByKey, meta.background),
    video: findFile(filesByKey, meta.video),
  };

  for (const [kind, reference] of /** @type {const} */ ([
    ['audio', meta.audio],
    ['cover', meta.cover],
    ['background', meta.background],
    ['video', meta.video],
  ])) {
    if (reference && !files[kind]) {
      warnings.push(
        songWarning('MISSING_FILE', `Referenced ${kind} file not found: ${reference}`, {
          kind,
          file: reference,
        }),
      );
    }
  }

  let coverGuessed = false;
  if (!files.cover) {
    files.cover = guessCover(fileNames);
    coverGuessed = files.cover !== null;
  }

  const folder = relativeDir.split(path.sep).join('/');
  return {
    id: songId(path.join(relativeDir, txtFile)),
    folder,
    txtFile,
    title: meta.title,
    artist: meta.artist,
    year: meta.year,
    decade: meta.decade,
    genres: splitList(meta.genre),
    languages: splitList(meta.language),
    editions: splitList(meta.edition),
    creators: splitList(meta.creator),
    tags: splitList(parsed.headers.TAGS),
    isDuet: stats.isDuet,
    ...previewOf(meta),
    formatVersion: meta.version,
    files,
    coverGuessed,
    encoding,
    warnings,
    modifiedAt,
  };
}

/**
 * Début de la preview : #PREVIEWSTART, sinon début du medley (#MEDLEYSTARTBEAT).
 * @param {import('../parsers/ultrastarTxt.js').SongMeta} meta
 * @returns {{ previewStart: number | null, previewSource: 'tag' | 'medley' | null }}
 */
export function previewOf(meta) {
  if (meta.previewStart !== null && meta.previewStart >= 0) {
    return { previewStart: meta.previewStart, previewSource: 'tag' };
  }
  if (meta.medleyStartBeat !== null && meta.bpm !== null) {
    const seconds = beatToSeconds(meta.medleyStartBeat, meta.bpm, meta.gap);
    if (seconds !== null && seconds >= 0) {
      return { previewStart: Math.round(seconds * 1000) / 1000, previewSource: 'medley' };
    }
  }
  return { previewStart: null, previewSource: null };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Tri par artiste puis titre, insensible à la casse et aux accents.
 * @param {Song} a
 * @param {Song} b
 * @returns {number}
 */
function compareSongs(a, b) {
  return (
    collator.compare(a.artist ?? '', b.artist ?? '') ||
    collator.compare(a.title ?? '', b.title ?? '') ||
    collator.compare(a.txtFile, b.txtFile)
  );
}

/**
 * Crée le catalogue.
 *
 * @param {object} options
 * @param {string | null} options.songDir  Dossier racine des chansons (null = non configuré).
 * @param {Pick<Console, 'info' | 'warn' | 'error'>} [options.logger]
 */
export function createCatalog({ songDir, logger = console }) {
  /** @type {Song[]} */
  let songs = [];
  /** @type {Map<string, Song>} */
  let songsById = new Map();
  /** @type {CatalogStatus} */
  let status = {
    state: songDir ? 'empty' : 'not-configured',
    count: 0,
    scannedAt: null,
    durationMs: null,
    skipped: [],
    errors: [],
    error: null,
  };
  /** @type {Promise<CatalogStatus> | null} */
  let loading = null;

  /**
   * @param {string} root
   * @param {SongDirectory} directory
   * @param {string} txtFile
   * @returns {Promise<{ song?: Song, skipped?: string, error?: string }>}
   */
  async function readSong(root, { relativeDir, fileNames }, txtFile) {
    const fullPath = path.join(root, relativeDir, txtFile);
    try {
      const [buffer, info] = await Promise.all([readFile(fullPath), stat(fullPath)]);
      const parsed = parseUltrastarTxt(buffer);
      if (!parsed.headers.TITLE && !parsed.headers.ARTIST) {
        return { skipped: 'Not an UltraStar file (no #TITLE / #ARTIST)' };
      }
      const song = buildSong({ relativeDir, txtFile, fileNames, parsed, modifiedAt: info.mtimeMs });
      return { song };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** @returns {Promise<CatalogStatus>} */
  async function scan() {
    if (!songDir) return status;
    const root = path.resolve(songDir);
    const startedAt = Date.now();
    status = { ...status, state: 'loading', error: null };

    try {
      const directories = await findSongDirectories(root);
      const jobs = directories.flatMap((directory) =>
        directory.fileNames
          .filter((name) => path.extname(name).toLowerCase() === '.txt')
          .map((txtFile) => ({ directory, txtFile })),
      );
      const results = await mapWithConcurrency(jobs, READ_CONCURRENCY, ({ directory, txtFile }) =>
        readSong(root, directory, txtFile),
      );

      /** @type {Song[]} */
      const loaded = [];
      /** @type {CatalogStatus['skipped']} */
      const skipped = [];
      /** @type {CatalogStatus['errors']} */
      const errors = [];
      results.forEach((result, index) => {
        const { directory, txtFile } = jobs[index];
        const relativePath = path.join(directory.relativeDir, txtFile).split(path.sep).join('/');
        if (result.song) loaded.push(result.song);
        else if (result.skipped) skipped.push({ path: relativePath, reason: result.skipped });
        else errors.push({ path: relativePath, message: result.error ?? 'Unknown error' });
      });

      for (const { path: file, message } of errors)
        logger.warn(`Unreadable song file ${file}: ${message}`);

      songs = loaded.sort(compareSongs);
      songsById = new Map(songs.map((song) => [song.id, song]));
      status = {
        state: 'ready',
        count: songs.length,
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        skipped,
        errors,
        error: null,
      };
      logger.info(`Catalog: ${songs.length} songs loaded in ${status.durationMs} ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Catalog scan failed: ${message}`);
      status = { ...status, state: 'error', error: message };
    }
    return status;
  }

  return {
    /**
     * Lance (ou relance) le scan. Des appels simultanés partagent le même scan.
     * @returns {Promise<CatalogStatus>}
     */
    load() {
      loading ??= scan().finally(() => {
        loading = null;
      });
      return loading;
    },

    /** @returns {readonly Song[]} Chansons triées par artiste puis titre. */
    getSongs() {
      return songs;
    },

    /**
     * @param {string} id
     * @returns {Song | undefined}
     */
    getSong(id) {
      return songsById.get(id);
    },

    /** @returns {Readonly<CatalogStatus>} */
    getStatus() {
      return status;
    },

    /**
     * Dossier absolu d'une chanson, garanti à l'intérieur de SONG_DIR (sinon null).
     * @param {Song} song
     * @returns {string | null}
     */
    resolveSongFolder(song) {
      return songDir ? resolveInside(songDir, song.folder) : null;
    },
  };
}

/** @typedef {ReturnType<typeof createCatalog>} Catalog */
