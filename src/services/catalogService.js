// @ts-check
/**
 * Catalogue des chansons : parcourt SONG_DIR, lit chaque fichier .txt UltraStar
 * et garde en mémoire la liste des chansons.
 *
 * Lecture seule : ce service ne modifie jamais la bibliothèque.
 * Les vidéos MP4 sont analysées (codec, résolution) en lisant seulement leur en-tête.
 *
 * @module services/catalogService
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isOversizedVideo, isRecommendedVideo } from '../parsers/mp4Video.js';
import { checkNaming, DEFAULT_NAMING } from '../parsers/naming.js';
import {
  beatToSeconds,
  parseNumber,
  parseUltrastarTxt,
  songWarning,
} from '../parsers/ultrastarTxt.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { resolveInside } from '../utils/safePath.js';
import { fileNameKey, splitList } from '../utils/text.js';
import { readReplayGain } from './replayGainService.js';
import { probeVideoFile } from './videoProbe.js';

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
 * @property {number} videoGap      Décalage de la vidéo en secondes (#VIDEOGAP, 0 par défaut).
 * @property {import('./videoProbe.js').ProbedVideo | null} video  Format, codec, résolution
 *   et date de modification de la vidéo (null sans vidéo).
 * @property {boolean} coverGuessed  Pochette trouvée par le marqueur [CO] et non par #COVER.
 * @property {string} encoding
 * @property {import('../parsers/ultrastarTxt.js').SongWarning[]} warnings
 * @property {import('../parsers/replayGain.js').ReplayGain | null} replayGain  Tags ReplayGain du
 *   fichier audio (MP3 seulement ; null si absents ou autre format).
 * @property {number} modifiedAt      Date de modification du .txt (ms).
 */

/**
 * @typedef {object} SongDetails Détail complet (fenêtre « info »), relu dans le .txt.
 * @property {Record<string, string>} headers  Tous les en-têtes bruts.
 * @property {import('../parsers/ultrastarTxt.js').SongStats} stats
 * @property {string} encoding
 * @property {{ bpm: number | null, gap: number | null, videoGap: number | null,
 *   previewStart: number | null, previewSource: string | null, medleyStart: number | null,
 *   medleyEnd: number | null, start: number | null, end: number | null }} timing
 *   Valeurs de synchronisation (GAP en ms, le reste en secondes).
 * @property {{ p1: string | null, p2: string | null }} singers  Noms des chanteurs d'un duo.
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
 * @param {import('../parsers/naming.js').NamingRules} [input.naming]  Modèles de nommage.
 * @returns {Song}
 */
export function buildSong({ relativeDir, txtFile, fileNames, parsed, modifiedAt, naming }) {
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

  // Cas rare : la vidéo sert aussi de musique. Elle ne doit pas être convertie (la conversion
  // retire la bande son), d'où un avertissement pour la repérer.
  if (files.audio && files.video && files.audio.toLowerCase() === files.video.toLowerCase()) {
    warnings.push(
      songWarning('VIDEO_IS_AUDIO', `Same file for #MP3 and #VIDEO: ${files.video}`, {
        file: files.video,
      }),
    );
  }

  let coverGuessed = false;
  if (!files.cover) {
    files.cover = guessCover(fileNames);
    coverGuessed = files.cover !== null;
  }

  // Nommage des dossiers et fichiers (« Artiste - Titre [suffixe] », voir parsers/naming.js).
  for (const problem of checkNaming(
    {
      artist: meta.artist,
      title: meta.title,
      folderName: path.basename(relativeDir),
      txtFile,
      isDuet: stats.isDuet,
      files: {
        ...files,
        vocals: findFile(filesByKey, parsed.headers.VOCALS),
        instrumental: findFile(filesByKey, parsed.headers.INSTRUMENTAL),
      },
    },
    naming,
  )) {
    warnings.push(
      songWarning(
        `NAMING_${problem.kind}`,
        `Name "${problem.actual}" should be "${problem.expected}"`,
        {
          file: problem.actual,
          expected: problem.expected,
        },
      ),
    );
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
    videoGap: meta.videoGap ?? 0,
    video: null,
    replayGain: null,
    coverGuessed,
    encoding,
    warnings,
    modifiedAt,
  };
}

/**
 * Ajoute à une chanson la description de sa vidéo, avec un avertissement si ce n'est pas
 * le format recommandé (MP4 H.264 : lu par UltraStar comme par les navigateurs, décodage
 * léger), ou si elle est plus grande que 1080p (4K…).
 *
 * @param {Song} song
 * @param {import('./videoProbe.js').ProbedVideo} video
 * @returns {Song}
 */
export function withVideoInfo(song, video) {
  const warnings = [...song.warnings];
  if (!isRecommendedVideo(video)) {
    const format = [video.container.toUpperCase(), video.codec?.toUpperCase()]
      .filter(Boolean)
      .join(' ');
    warnings.push(
      songWarning('VIDEO_NOT_H264', `Video is ${format}: MP4 H.264 recommended`, { format }),
    );
  }
  if (isOversizedVideo(video)) {
    const size = `${video.width}×${video.height}`;
    warnings.push(
      songWarning('VIDEO_TOO_LARGE', `Video is ${size}: 1080p is enough`, {
        width: video.width ?? 0,
        height: video.height ?? 0,
      }),
    );
  }
  return { ...song, video, warnings };
}

/** Formats audio dont les tags ReplayGain sont lus (et donc signalés quand ils manquent). */
export const REPLAYGAIN_EXTENSIONS = Object.freeze(['.mp3']);

/**
 * Ajoute à une chanson ses tags ReplayGain, avec un avertissement s'ils manquent
 * (seulement pour les formats lus : MP3).
 *
 * @param {Song} song
 * @param {import('../parsers/replayGain.js').ReplayGain | null} replayGain
 * @returns {Song}
 */
export function withReplayGain(song, replayGain) {
  const audio = song.files.audio;
  if (replayGain || !audio) return { ...song, replayGain };
  if (!REPLAYGAIN_EXTENSIONS.includes(path.extname(audio).toLowerCase())) return song;
  const warning = songWarning('REPLAYGAIN_MISSING', `No ReplayGain tags in ${audio}`, {
    file: audio,
  });
  return { ...song, replayGain: null, warnings: [...song.warnings, warning] };
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
 * @param {() => import('../parsers/naming.js').NamingRules} [options.getNaming]  Modèles de
 *   nommage en cours (préférences), relus à chaque scan.
 */
export function createCatalog({ songDir, logger = console, getNaming = () => DEFAULT_NAMING }) {
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
      const song = buildSong({
        relativeDir,
        txtFile,
        fileNames,
        parsed,
        modifiedAt: info.mtimeMs,
        naming: getNaming(),
      });
      const folder = path.join(root, relativeDir);
      let result = song;
      if (song.files.video) {
        result = withVideoInfo(result, await probeVideoFile(path.join(folder, song.files.video)));
      }
      if (song.files.audio) {
        result = withReplayGain(result, await readReplayGain(path.join(folder, song.files.audio)));
      }
      return { song: result };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** @returns {Promise<CatalogStatus>} */
  async function scan() {
    if (!songDir) return status;
    const root = path.resolve(songDir);
    const startedAt = Date.now();
    // Relecture : la liste actuelle reste servie pendant le scan (état « ready » conservé).
    if (status.state !== 'ready') status = { ...status, state: 'loading', error: null };

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
     * Détail complet d'une chanson : relit son .txt (tous les en-têtes, statistiques).
     * @param {Song} song
     * @returns {Promise<SongDetails | null>} null si le fichier n'est plus lisible.
     */
    async readDetails(song) {
      const folder = songDir ? resolveInside(songDir, song.folder) : null;
      const file = folder ? resolveInside(folder, song.txtFile) : null;
      if (!file) return null;
      try {
        const parsed = parseUltrastarTxt(await readFile(file));
        const { meta } = parsed;
        /** @param {number | null} beat */
        const seconds = (beat) =>
          beat === null || meta.bpm === null ? null : beatToSeconds(beat, meta.bpm, meta.gap);
        return {
          headers: parsed.headers,
          stats: parsed.stats,
          encoding: parsed.encoding,
          timing: {
            bpm: meta.bpm,
            gap: meta.gap,
            videoGap: meta.videoGap,
            previewStart: song.previewStart,
            previewSource: song.previewSource,
            medleyStart: seconds(meta.medleyStartBeat),
            medleyEnd: seconds(meta.medleyEndBeat),
            start: parseNumber(parsed.headers.START),
            end: parseNumber(parsed.headers.END),
          },
          singers: {
            p1: parsed.headers.P1 ?? parsed.headers.DUETSINGERP1 ?? null,
            p2: parsed.headers.P2 ?? parsed.headers.DUETSINGERP2 ?? null,
          },
        };
      } catch {
        return null;
      }
    },

    /**
     * Fichier .txt absolu d'une chanson, garanti à l'intérieur de SONG_DIR (sinon null).
     * @param {Song} song
     * @returns {string | null}
     */
    resolveSongFile(song) {
      const folder = songDir ? resolveInside(songDir, song.folder) : null;
      return folder ? resolveInside(folder, song.txtFile) : null;
    },

    /**
     * Relit une seule chanson (après une modification) et met le catalogue à jour.
     * @param {string} id
     * @returns {Promise<Song | null>} La chanson à jour, ou null si elle n'est plus lisible.
     */
    async refreshSong(id) {
      const song = songsById.get(id);
      if (!song || !songDir) return null;
      const root = path.resolve(songDir);
      const relativeDir = song.folder.split('/').join(path.sep);
      const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
      const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
      const result = await readSong(root, { relativeDir, fileNames }, song.txtFile);
      if (!result.song) return null;
      const updated = result.song;
      songs = songs.map((s) => (s.id === id ? updated : s)).sort(compareSongs);
      songsById.set(id, updated);
      return updated;
    },

    /**
     * Relit toutes les chansons d'un dossier, après un renommage : les chansons de l'ancien
     * dossier disparaissent, celles du nouveau sont lues (leurs identifiants changent, car ils
     * dépendent du chemin).
     * @param {string} oldFolder  Dossier relatif, séparateur « / ».
     * @param {string} newFolder
     * @returns {Promise<Song[]>} Chansons du nouveau dossier.
     */
    async replaceFolder(oldFolder, newFolder) {
      if (!songDir) return [];
      const root = path.resolve(songDir);
      const relativeDir = newFolder.split('/').join(path.sep);
      const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
      const fileNames = entries
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name);
      const txtFiles = fileNames.filter((name) => path.extname(name).toLowerCase() === '.txt');
      const results = await Promise.all(
        txtFiles.map((txtFile) => readSong(root, { relativeDir, fileNames }, txtFile)),
      );
      const fresh = results.flatMap((result) => (result.song ? [result.song] : []));
      songs = [
        ...songs.filter((s) => s.folder !== oldFolder && s.folder !== newFolder),
        ...fresh,
      ].sort(compareSongs);
      songsById = new Map(songs.map((song) => [song.id, song]));
      status = { ...status, count: songs.length };
      return fresh;
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
