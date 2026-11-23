// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createFakeFfmpeg } from '../helpers/fakeFfmpeg.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    'lib/clip/a.txt': '#TITLE:T\n#ARTIST:A\n#MP3:a.mp3\n#VIDEO:clip.avi\n#BPM:300\n: 0 1 0 la\nE\n',
    'lib/clip/clip.avi': 'AVI',
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
  const baseUrl = `http://127.0.0.1:${port}`;
  const write = { 'x-usm-request': '1' };
  return {
    /** @param {unknown} body */
    post: (body, url = '/api/bulk/convert-video') =>
      request(baseUrl, url, { method: 'POST', headers: write, body }),
    get: () => request(baseUrl, '/api/bulk/convert-video'),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('/api/bulk/convert-video', () => {
  it('simulation, lancement d’un lot (202), suivi jusqu’à la fin', async () => {
    const app = await setup({});
    try {
      assert.equal((await app.get()).json.data.batch, null);
      const dry = await app.post({ dryRun: true });
      assert.equal(dry.status, 200);
      assert.equal(dry.json.data.available, true);
      const [item] = dry.json.data.items;
      assert.equal(item.container, 'avi');
      assert.equal(item.size, 3);

      const started = await app.post({
        items: [{ id: item.id, expectedModifiedAt: item.modifiedAt }],
      });
      assert.equal(started.status, 202);
      let { batch } = started.json.data;
      while (batch.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        batch = (await app.get()).json.data.batch;
      }
      assert.equal(batch.state, 'done');
      assert.equal(batch.items[0].status, 'converted');
      // Arrêt sans lot en cours : sans effet
      assert.equal(
        (await app.post({}, '/api/bulk/convert-video/stop')).json.data.batch.state,
        'done',
      );
    } finally {
      await app.close();
    }
  });

  it('400 pour un corps invalide', async () => {
    const app = await setup({});
    try {
      for (const body of [{}, { items: [] }, { items: [{ id: 'x' }] }]) {
        assert.equal((await app.post(body)).status, 400);
      }
    } finally {
      await app.close();
    }
  });

  it('lecture publique : 403 partout', async () => {
    const app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      assert.equal((await app.post({ dryRun: true })).status, 403);
      assert.equal((await app.get()).status, 403);
      assert.equal((await app.post({}, '/api/bulk/convert-video/stop')).status, 403);
    } finally {
      await app.close();
    }
  });
});
