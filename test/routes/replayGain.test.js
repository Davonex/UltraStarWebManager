// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createFakeFfmpeg } from '../helpers/fakeFfmpeg.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary, songTxt } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const MP3 = Buffer.alloc(2000, 0xfb);

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    'lib/s/a.txt': songTxt({ TITLE: 'T', ARTIST: 'A', MP3: 'a.mp3', BPM: '300' }),
    'lib/s/a.mp3': MP3,
  });
  const catalog = createCatalog({ songDir: path.join(library.root, 'lib'), logger: silentLogger });
  await catalog.load();
  const server = createApp(loadConfig({ ...env, BACKUP_DIR: path.join(library.root, 'backups') }), {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
    ffmpeg: createFakeFfmpeg(),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const id = catalog.getSongs()[0].id;
  return {
    library,
    /** @param {unknown} body */
    post: (body) =>
      request(`http://127.0.0.1:${port}`, `/api/songs/${id}/replaygain`, {
        method: 'POST',
        headers: { 'x-usm-request': '1' },
        body,
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('POST /api/songs/:id/replaygain', () => {
  it('mesure (dryRun) puis écriture', async () => {
    const app = await setup({});
    try {
      const measured = await app.post({ dryRun: true });
      assert.equal(measured.status, 200);
      const { trackGain, trackPeak, audioModifiedAt } = measured.json.data;
      const written = await app.post({
        trackGain,
        trackPeak,
        expectedAudioModifiedAt: audioModifiedAt,
      });
      assert.equal(written.status, 200, JSON.stringify(written.json));
      assert.equal(written.json.data.song.replayGain.trackGain, -2.54);
      assert.equal((await app.post({})).status, 400);
    } finally {
      await app.close();
    }
  });

  it('lecture publique : 403, fichier intact', async () => {
    const app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      assert.equal((await app.post({ dryRun: true })).status, 403);
      assert.deepEqual(await readFile(path.join(app.library.root, 'lib/s/a.mp3')), MP3);
    } finally {
      await app.close();
    }
  });
});
