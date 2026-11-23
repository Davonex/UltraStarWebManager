// @ts-check
/**
 * Faux ffmpeg pour les tests : écrit un petit MP4 H.264 synthétique au lieu de convertir.
 * @module test/helpers/fakeFfmpeg
 */
import { writeFile } from 'node:fs/promises';
import { H264_720P, mp4File, track } from './mp4.js';

/**
 * @param {object} [options]
 * @param {boolean} [options.available]
 * @param {'h264' | 'broken'} [options.output]  broken : produit un fichier non H.264.
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
  };
}

/**
 * Attend qu'une condition soit vraie (tâche de fond).
 * @param {() => boolean} condition
 */
export async function waitFor(condition, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('waitFor: délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
