// @ts-check
/**
 * ReplayGain des fichiers audio :
 * - lecture des tags (en-tête ID3v2 puis, à défaut, tag APEv2 en fin de fichier ; quelques Ko) ;
 * - calcul avec ffmpeg et écriture dans le tag ID3 (createReplayGainTool).
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
 * @param {Pick<Console, 'info'>} [options.logger]
 */
export function createReplayGainTool({ catalog, ffmpeg, backupDir, logger = console }) {
  /** Une mesure à la fois (ffmpeg décode tout le morceau). */
  let busy = false;

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
     * @returns {Promise<{ song: import('./catalogService.js').Song, backup: string }>}
     * @throws {SongEditError}
     */
    async write(id, { trackGain, trackPeak, expectedAudioModifiedAt }) {
      if (!(Math.abs(trackGain) <= 60 && trackPeak >= 0 && trackPeak <= 10)) {
        throw new SongEditError('INVALID_VALUE', 'ReplayGain values out of range', 400);
      }
      const { song, name, file } = audioOf(id);
      const [data, info] = await Promise.all([readFile(file), stat(file)]);
      if (Math.abs(info.mtimeMs - expectedAudioModifiedAt) > 1) {
        throw new SongEditError(
          'SONG_CHANGED',
          'The audio file changed since it was measured',
          409,
        );
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
      const backup = await backupFile({ file, relativePath: `${song.folder}/${name}`, backupDir });
      await writeFileAtomic(file, updated);
      logger.info(
        `ReplayGain written to ${song.folder}/${name}: ${formatGain(trackGain)} (backup: ${backup})`,
      );
      return { song: (await catalog.refreshSong(id)) ?? song, backup };
    },
  };
}

/** @typedef {ReturnType<typeof createReplayGainTool>} ReplayGainTool */
