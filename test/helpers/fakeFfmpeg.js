// @ts-check
/**
 * Faux ffmpeg pour les tests : écrit un petit MP4 H.264 synthétique au lieu de convertir.
 * @module test/helpers/fakeFfmpeg
 */
import { writeFile } from 'node:fs/promises';
import { FfmpegError } from '../../src/services/ffmpegService.js';
import { H264_720P, mp4File, track } from './mp4.js';

/** Faux MP3 produit par l'extraction (en-tête ID3 + données). */
export const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, 1)]);

/**
 * @param {object} [options]
 * @param {boolean} [options.available]
 * @param {'h264' | 'broken'} [options.output]  broken : vidéo non H.264, MP3 vide.
 * @param {Promise<void>} [options.gate]  La conversion attend cette promesse (tâche « longue »).
 * @returns {import('../../src/services/ffmpegService.js').Ffmpeg & { calls: string[] }}
 */
export function createFakeFfmpeg({ available = true, output = 'h264', gate } = {}) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    isAvailable: async () => available,
    probe: async () => ({ codec: 'mpeg4', width: 720, height: 576, duration: 10, frameRate: 25 }),
    async convertToH264({ input, output: file, onProgress }) {
      calls.push(input);
      onProgress?.(5);
      await gate;
      const data =
        output === 'h264'
          ? H264_720P()
          : mp4File({ tracks: [track({ handler: 'vide', codec: 'mp4v', width: 2, height: 2 })] });
      await writeFile(file, data);
    },
    async analyzeReplayGain(input) {
      calls.push(`replaygain:${input}`);
      await gate;
      if (output === 'broken') throw new FfmpegError('REPLAYGAIN_FAILED', 'no values');
      return { trackGain: -2.54, trackPeak: 0.85336 };
    },
    async extractAudioToMp3({ input, output: file }) {
      calls.push(`audio:${input}`);
      await gate;
      await writeFile(file, output === 'broken' ? Buffer.alloc(0) : FAKE_MP3);
    },
  };
}

/**
 * Attend qu'une condition soit vraie (tâche de fond).
 * @param {() => boolean} condition
 */
export async function waitFor(condition, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('waitFor: délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
