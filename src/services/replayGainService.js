// @ts-check
/**
 * ReplayGain des fichiers audio :
 * - lecture des tags (en-tête ID3v2 puis, à défaut, tag APEv2 en fin de fichier ; quelques Ko) ;
 * - calcul avec ffmpeg et écriture dans le tag ID3 (createReplayGainTool), pour une chanson ou
 *   par lot en tâche de fond (corrections en masse).
 * @module services/replayGainService
 */
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  APE_FOOTER_SIZE,
  buildId3WithReplayGain,
  formatGain,
  ID3_HEADER_SIZE,
  id3TagSize,
  locateApeTag,
  parseApeReplayGain,
  parseId3ReplayGain,
  UnsupportedTagError,
} from '../parsers/replayGain.js';
import { resolveInside } from '../utils/safePath.js';
import { FfmpegError } from './ffmpegService.js';
import { backupFile, writeFileAtomic } from './fileWriter.js';
import { SongEditError } from './songEditService.js';

/**
 * @typedef {object} ReplayGainCandidate  MP3 sans ReplayGain (simulation en masse).
 * @property {string} id
 * @property {string | null} artist
 * @property {string | null} title
 * @property {string} file    « dossier/fichier.mp3 ».
 * @property {number | null} size  Octets (une copie va dans les sauvegardes).
 * @property {number} audioModifiedAt  Date du MP3 (contrôle « modifié entre-temps »).
 * @property {number} sharedBy  Nombre d'autres .txt qui utilisent le même MP3 (duo…).
 */

/**
 * @typedef {object} ReplayGainBatchItem
 * @property {string} id
 * @property {string | null} artist
 * @property {string | null} title
 * @property {'pending' | 'running' | 'converted' | 'error' | 'skipped'} status
 * @property {number | null} trackGain  Gain écrit (dB).
 * @property {string | null} code
 */

/**
 * @typedef {object} ReplayGainBatch  Lot de calculs (un seul à la fois).
 * @property {'running' | 'done' | 'stopped'} state
 * @property {boolean} stopRequested
 * @property {number} startedAt
 * @property {number | null} finishedAt
 * @property {ReplayGainBatchItem[]} items
 */

/**
 * @typedef {Omit<ReplayGainBatch, 'items'> & { items: (ReplayGainBatchItem & { expected: number })[] }} InternalBatch
 *   Lot gardé en mémoire : chaque élément garde la date attendue du MP3 (non renvoyée).
 */

/** Taille maximale lue pour un tag (les pochettes intégrées peuvent être grosses). */
const MAX_TAG_BYTES = 16 * 1024 * 1024;

/**
 * @param {string} file  Chemin absolu du fichier audio.
 * @returns {Promise<import('../parsers/replayGain.js').ReplayGain | null>}  null : pas de
 *   ReplayGain (ou fichier illisible). Jamais d'exception.
 */
export async function readReplayGain(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size: fileSize } = await handle.stat();

    const header = new Uint8Array(ID3_HEADER_SIZE);
    await handle.read(header, 0, ID3_HEADER_SIZE, 0);
    const id3Size = Math.min(id3TagSize(header), fileSize, MAX_TAG_BYTES);
    if (id3Size > 0) {
      const tag = new Uint8Array(id3Size);
      await handle.read(tag, 0, id3Size, 0);
      const fromId3 = parseId3ReplayGain(tag);
      if (fromId3) return fromId3;
    }

    const tailSize = Math.min(fileSize, APE_FOOTER_SIZE + 128);
    const tail = new Uint8Array(tailSize);
    await handle.read(tail, 0, tailSize, fileSize - tailSize);
    const ape = locateApeTag(tail, fileSize);
    if (!ape || ape.start < 0 || ape.size <= 0 || ape.size > MAX_TAG_BYTES) return null;
    const items = new Uint8Array(ape.size);
    await handle.read(items, 0, ape.size, ape.start);
    return parseApeReplayGain(items);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Calcul et écriture du ReplayGain d'un MP3 (niveau écriture).
 *
 * 1. `measure` : ffmpeg mesure le gain et la crête de la piste ; rien n'est écrit ;
 * 2. `write` : les valeurs sont écrites dans le tag ID3 (cadres TXXX REPLAYGAIN_TRACK_*).
 *    Seul le tag change : les données audio sont recopiées octet pour octet. Sauvegarde datée
 *    du MP3, écriture atomique, refus si le fichier a changé depuis la mesure.
 *
 * @param {object} options
 * @param {import('./catalogService.js').Catalog} options.catalog
 * @param {import('./ffmpegService.js').Ffmpeg} options.ffmpeg
 * @param {string} options.backupDir
 * @param {() => boolean} [options.backupOriginal]  Préférence : copier le MP3 dans BACKUP_DIR
 *   avant d'écrire son tag (oui par défaut).
 * @param {Pick<Console, 'info'> & Partial<Pick<Console, 'warn'>>} [options.logger]
 */
export function createReplayGainTool({
  catalog,
  ffmpeg,
  backupDir,
  backupOriginal = () => true,
  logger = console,
}) {
  /** Une mesure à la fois (ffmpeg décode tout le morceau). */
  let busy = false;
  /** Lot en cours ou dernier lot. */
  /** @type {InternalBatch | null} */
  let batch = null;

  /** Clé d'un fichier audio partagé (même dossier, même nom, casse ignorée). @param {import('./catalogService.js').Song} song */
  const audioKey = (song) => `${song.folder}/${song.files.audio ?? ''}`.toLowerCase();

  /**
   * Après écriture : toutes les chansons qui utilisent ce MP3 (solo, duo…) sont relues, pour
   * que leur avertissement « pas de ReplayGain » disparaisse aussi.
   * @param {import('./catalogService.js').Song} song
   */
  async function refreshSharing(song) {
    const key = audioKey(song);
    const sharing = catalog.getSongs().filter((other) => audioKey(other) === key);
    for (const other of sharing) await catalog.refreshSong(other.id);
    return catalog.getSong(song.id) ?? song;
  }

  /**
   * Mesure puis écrit, pour un élément du lot (ffmpeg déjà réservé).
   * @param {ReplayGainBatchItem & { expected: number }} item
   */
  async function processItem(item) {
    const { file } = audioOf(item.id);
    const { mtimeMs } = await stat(file);
    if (Math.abs(mtimeMs - item.expected) > 1) {
      throw new SongEditError('SONG_CHANGED', 'The audio file changed since the simulation', 409);
    }
    if (await readReplayGain(file)) return null; // déjà fait entre-temps (autre .txt, autre outil)
    let measured;
    try {
      measured = await ffmpeg.analyzeReplayGain(file);
    } catch (error) {
      if (error instanceof FfmpegError) throw new SongEditError(error.code, error.message, 500);
      throw error;
    }
    await writeTag(item.id, { ...measured, expectedAudioModifiedAt: mtimeMs });
    return measured.trackGain;
  }

  /** @param {InternalBatch} target */
  async function runBatch(target) {
    for (const item of target.items) {
      if (target.stopRequested) {
        item.status = 'skipped';
        continue;
      }
      item.status = 'running';
      try {
        const gain = await processItem(item);
        item.status = gain === null ? 'skipped' : 'converted';
        item.trackGain = gain;
      } catch (error) {
        if (!(error instanceof SongEditError)) logger.warn?.(`ReplayGain batch: ${error}`);
        item.status = 'error';
        item.code = error instanceof SongEditError ? error.code : 'REPLAYGAIN_FAILED';
      }
    }
    target.state = target.stopRequested ? 'stopped' : 'done';
    target.finishedAt = Date.now();
    const done = target.items.filter((i) => i.status === 'converted').length;
    logger.info(`ReplayGain batch ${target.state}: ${done}/${target.items.length} written`);
  }

  /** @param {InternalBatch} source @returns {ReplayGainBatch} */
  const copyBatch = (source) => ({
    ...source,
    items: source.items.map(({ expected: _expected, ...item }) => ({ ...item })),
  });

  /**
   * Fichier MP3 de la chanson (dans SONG_DIR), ou erreur.
   * @param {string} id
   */
  function audioOf(id) {
    const song = catalog.getSong(id);
    if (!song) throw new SongEditError('SONG_NOT_FOUND', 'Song not found', 404);
    const folder = catalog.resolveSongFolder(song);
    const name = song.files.audio;
    const file = folder && name ? resolveInside(folder, name) : null;
    if (!file || !name || path.extname(name).toLowerCase() !== '.mp3') {
      throw new SongEditError('REPLAYGAIN_NOT_MP3', 'Only MP3 files are supported', 409);
    }
    return { song, name, file };
  }

  /**
   * Écrit les valeurs mesurées dans le tag ID3 du MP3.
   * @param {string} id
   * @param {{ trackGain: number, trackPeak: number, expectedAudioModifiedAt: number }} values
   * @returns {Promise<{ song: import('./catalogService.js').Song, backup: string | null }>}
   *   `backup` : null si la sauvegarde est désactivée (préférences).
   * @throws {SongEditError}
   */
  async function writeTag(id, { trackGain, trackPeak, expectedAudioModifiedAt }) {
    if (!(Math.abs(trackGain) <= 60 && trackPeak >= 0 && trackPeak <= 10)) {
      throw new SongEditError('INVALID_VALUE', 'ReplayGain values out of range', 400);
    }
    const { song, name, file } = audioOf(id);
    const [data, info] = await Promise.all([readFile(file), stat(file)]);
    if (Math.abs(info.mtimeMs - expectedAudioModifiedAt) > 1) {
      throw new SongEditError('SONG_CHANGED', 'The audio file changed since it was measured', 409);
    }
    const oldSize = id3TagSize(data.subarray(0, ID3_HEADER_SIZE));
    let tag;
    try {
      tag = buildId3WithReplayGain(oldSize > 0 ? data.subarray(0, oldSize) : null, {
        REPLAYGAIN_TRACK_GAIN: formatGain(trackGain),
        REPLAYGAIN_TRACK_PEAK: trackPeak.toFixed(6),
      });
    } catch (error) {
      if (!(error instanceof UnsupportedTagError)) throw error;
      throw new SongEditError('REPLAYGAIN_TAG_UNSUPPORTED', error.message, 422);
    }
    // Nouveau tag + données audio d'origine, inchangées.
    const updated = Buffer.concat([tag, data.subarray(oldSize)]);
    // Sauvegarde du MP3 (désactivable dans les préférences : seul le tag change).
    const backup = backupOriginal()
      ? await backupFile({ file, relativePath: `${song.folder}/${name}`, backupDir })
      : null;
    await writeFileAtomic(file, updated);
    logger.info(
      `ReplayGain written to ${song.folder}/${name}: ${formatGain(trackGain)} (backup: ${backup ?? 'disabled'})`,
    );
    return { song: await refreshSharing(song), backup };
  }

  return {
    /**
     * Mesure le ReplayGain (rien n'est écrit).
     * @param {string} id
     * @returns {Promise<{ trackGain: number, trackPeak: number, audioModifiedAt: number }>}
     * @throws {SongEditError}
     */
    async measure(id) {
      const { file } = audioOf(id);
      if (!(await ffmpeg.isAvailable())) {
        throw new SongEditError('FFMPEG_NOT_AVAILABLE', 'ffmpeg is not available', 503);
      }
      if (busy) throw new SongEditError('CONVERSION_BUSY', 'Another analysis is running', 409);
      busy = true;
      try {
        const { mtimeMs } = await stat(file);
        const { trackGain, trackPeak } = await ffmpeg.analyzeReplayGain(file);
        return { trackGain, trackPeak, audioModifiedAt: mtimeMs };
      } catch (error) {
        if (error instanceof FfmpegError) throw new SongEditError(error.code, error.message, 500);
        throw error;
      } finally {
        busy = false;
      }
    },

    /**
     * Écrit les valeurs mesurées dans le tag ID3 du MP3.
     * @param {string} id
     * @param {{ trackGain: number, trackPeak: number, expectedAudioModifiedAt: number }} values
     * @returns {Promise<{ song: import('./catalogService.js').Song, backup: string | null }>}
     * @throws {SongEditError}
     */
    write: (id, values) => writeTag(id, values),

    /**
     * MP3 sans ReplayGain (simulation des corrections en masse), un par fichier : un MP3
     * partagé par le solo et le duo n'est listé (et calculé) qu'une fois.
     * @returns {Promise<{ available: boolean, backup: boolean, items: ReplayGainCandidate[] }>}
     *   `backup` : les MP3 seront sauvegardés (préférence).
     */
    async listCandidates() {
      /** @type {Map<string, import('./catalogService.js').Song[]>} */
      const byFile = new Map();
      for (const song of catalog.getSongs()) {
        if (!song.warnings.some((w) => w.code === 'REPLAYGAIN_MISSING')) continue;
        const key = audioKey(song);
        byFile.set(key, [...(byFile.get(key) ?? []), song]);
      }
      /** @type {ReplayGainCandidate[]} */
      const items = [];
      for (const songs of byFile.values()) {
        const song = songs.find((s) => !s.isDuet) ?? songs[0];
        let info = null;
        try {
          info = await stat(audioOf(song.id).file);
        } catch {
          continue; // fichier disparu ou non MP3 : ignoré
        }
        items.push({
          id: song.id,
          artist: song.artist,
          title: song.title,
          file: `${song.folder}/${song.files.audio}`,
          size: info.size,
          audioModifiedAt: info.mtimeMs,
          sharedBy: songs.length - 1,
        });
      }
      return { available: await ffmpeg.isAvailable(), backup: backupOriginal(), items };
    },

    /**
     * Lance un lot : chaque MP3 est mesuré puis son tag écrit, l'un après l'autre, en tâche
     * de fond. Un MP3 modifié depuis la simulation est ignoré (jamais écrasé).
     * @param {{ id: string, expectedAudioModifiedAt: number }[]} items
     * @returns {Promise<ReplayGainBatch>}
     * @throws {SongEditError} FFMPEG_NOT_AVAILABLE, CONVERSION_BUSY
     */
    async startBatch(items) {
      if (!(await ffmpeg.isAvailable())) {
        throw new SongEditError('FFMPEG_NOT_AVAILABLE', 'ffmpeg is not available', 503);
      }
      if (busy) throw new SongEditError('CONVERSION_BUSY', 'Another analysis is running', 409);
      /** @type {InternalBatch} */
      const created = {
        state: 'running',
        stopRequested: false,
        startedAt: Date.now(),
        finishedAt: null,
        items: items.map(({ id, expectedAudioModifiedAt }) => {
          const song = catalog.getSong(id);
          return {
            id,
            expected: expectedAudioModifiedAt,
            artist: song?.artist ?? null,
            title: song?.title ?? null,
            status: /** @type {const} */ ('pending'),
            trackGain: null,
            code: null,
          };
        }),
      };
      batch = created;
      busy = true;
      runBatch(created).finally(() => {
        busy = false;
      });
      return copyBatch(created);
    },

    /** @returns {ReplayGainBatch | null} Lot en cours ou dernier lot terminé. */
    getBatch() {
      return batch ? copyBatch(batch) : null;
    },

    /**
     * Arrêt du lot après le fichier en cours.
     * @returns {ReplayGainBatch | null}
     */
    stopBatch() {
      if (batch?.state === 'running') batch.stopRequested = true;
      return batch ? copyBatch(batch) : null;
    },
  };
}

/** @typedef {ReturnType<typeof createReplayGainTool>} ReplayGainTool */
