// @ts-check
/**
 * Appel de ffmpeg / ffprobe, programmes externes (pas une dépendance npm).
 * FFMPEG_PATH donne le chemin de ffmpeg ; ffprobe est cherché dans le même dossier.
 *
 * Sécurité : les programmes sont lancés sans shell, avec une liste d'arguments
 * (aucun risque d'injection par un nom de fichier).
 *
 * @module services/ffmpegService
 */
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Intervalle entre deux images clés (s) : démarrage et sauts rapides dans UltraStar. */
export const KEYFRAME_INTERVAL_S = 2;
/** Qualité constante x264 (plus petit = meilleur et plus lourd). */
export const H264_CRF = 22;

/**
 * Chemin de ffprobe à côté de ffmpeg (« C:\ffmpeg\bin\ffmpeg.exe » → « …\ffprobe.exe »).
 * @param {string} ffmpegPath
 * @returns {string}
 */
export function ffprobePathFor(ffmpegPath) {
  const dir = path.dirname(ffmpegPath);
  const name = path.basename(ffmpegPath).replace(/ffmpeg/i, 'ffprobe');
  return dir === '.' ? name : path.join(dir, name);
}

/**
 * Mise à l'échelle : résolution d'origine conservée, sauf au-delà de 1920 × 1080 (4K…) où la
 * vidéo est réduite en gardant ses proportions. Jamais agrandie. Dimensions arrondies au pair
 * (exigé par yuv420p) : au plus un pixel retiré.
 */
export const SCALE_FILTER =
  "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

/**
 * Arguments de conversion en MP4 H.264 (voir SCALE_FILTER pour la résolution).
 * - Pas d'audio : UltraStar lit le MP3 de la chanson.
 * - faststart : index en tête de fichier, la vidéo démarre tout de suite.
 *
 * @param {string} input
 * @param {string} output
 * @returns {string[]}
 */
export function buildConvertArgs(input, output) {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(H264_CRF),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    SCALE_FILTER,
    '-force_key_frames',
    `expr:gte(t,n_forced*${KEYFRAME_INTERVAL_S})`,
    '-an',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];
}

/**
 * Dernière position (s) annoncée dans la sortie « -progress » de ffmpeg (null si aucune).
 * @param {string} text
 * @returns {number | null}
 */
export function parseProgress(text) {
  const matches = [...text.matchAll(/^out_time_(?:us|ms)=(\d+)$/gm)];
  const last = matches.at(-1);
  return last ? Number(last[1]) / 1_000_000 : null;
}

/**
 * @typedef {object} ProbeResult  Description d'une vidéo par ffprobe.
 * @property {string | null} codec
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} duration   En secondes.
 * @property {number | null} frameRate  Images par seconde.
 */

/**
 * Lit la sortie JSON de ffprobe.
 * @param {string} json
 * @returns {ProbeResult}
 */
export function parseProbeOutput(json) {
  const data = JSON.parse(json);
  const stream = data.streams?.[0] ?? {};
  const [num, den] = String(stream.avg_frame_rate ?? '')
    .split('/')
    .map(Number);
  const number = (/** @type {unknown} */ value) =>
    Number.isFinite(Number(value)) && value !== undefined ? Number(value) : null;
  return {
    codec: stream.codec_name ?? null,
    width: number(stream.width),
    height: number(stream.height),
    duration: number(data.format?.duration ?? stream.duration),
    frameRate: num > 0 && den > 0 ? Math.round((num / den) * 100) / 100 : null,
  };
}

/** Erreur de ffmpeg (programme absent, conversion échouée…). */
export class FfmpegError extends Error {
  /**
   * @param {'FFMPEG_NOT_AVAILABLE' | 'VIDEO_CONVERSION_FAILED'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {string} options.ffmpegPath  « ffmpeg » (dans le PATH) ou chemin complet.
 * @param {Pick<Console, 'info' | 'warn'>} [options.logger]
 */
export function createFfmpeg({ ffmpegPath, logger = console }) {
  const ffprobePath = ffprobePathFor(ffmpegPath);
  /** @type {Promise<boolean> | null} */
  let available = null;

  return {
    /**
     * ffmpeg et ffprobe répondent-ils ? (testé une fois, résultat gardé)
     * @returns {Promise<boolean>}
     */
    isAvailable() {
      available ??= Promise.all([
        execFileAsync(ffmpegPath, ['-version']),
        execFileAsync(ffprobePath, ['-version']),
      ]).then(
        () => true,
        () => {
          logger.warn(`ffmpeg not found (${ffmpegPath}): video conversion disabled`);
          return false;
        },
      );
      return available;
    },

    /**
     * Codec, résolution, durée de la première piste vidéo.
     * @param {string} file
     * @returns {Promise<ProbeResult>}
     */
    async probe(file) {
      const { stdout } = await execFileAsync(ffprobePath, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,avg_frame_rate,duration:format=duration',
        '-of',
        'json',
        file,
      ]);
      return parseProbeOutput(stdout);
    },

    /**
     * Convertit en MP4 H.264 (voir buildConvertArgs).
     * @param {object} job
     * @param {string} job.input
     * @param {string} job.output
     * @param {(seconds: number) => void} [job.onProgress]  Position atteinte (s).
     * @returns {Promise<void>}
     */
    convertToH264({ input, output, onProgress }) {
      return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, buildConvertArgs(input, output), { windowsHide: true });
        // Priorité basse : le PC reste utilisable pendant une longue série de conversions.
        try {
          if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // Sans importance : la conversion se fait simplement en priorité normale.
        }
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
          const seconds = parseProgress(chunk);
          if (seconds !== null) onProgress?.(seconds);
        });
        child.stderr.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
          stderr = (stderr + chunk).slice(-4000); // garde la fin pour le journal
        });
        child.on('error', (error) =>
          reject(new FfmpegError('FFMPEG_NOT_AVAILABLE', `Cannot run ffmpeg: ${error.message}`)),
        );
        child.on('close', (code) => {
          if (code === 0) resolve();
          else {
            logger.warn(
              `ffmpeg failed (${code}) for ${input}:\n${stderr.trim().split('\n').slice(-5).join('\n')}`,
            );
            reject(new FfmpegError('VIDEO_CONVERSION_FAILED', `ffmpeg exited with code ${code}`));
          }
        });
      });
    },
  };
}

/** @typedef {ReturnType<typeof createFfmpeg>} Ffmpeg */
