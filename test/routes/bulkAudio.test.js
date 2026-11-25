// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createFakeFfmpeg, FAKE_MP3 } from '../helpers/fakeFfmpeg.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    // Solo et duo dans le même dossier, tous deux sur clip.mp4 : un seul MP3 créé, réutilisé
    'lib/clip/a.txt':
      '#TITLE:T\n#ARTIST:A\n#MP3:clip.mp4\n#VIDEO:clip.mp4\n#BPM:300\n: 0 1 0 la\nE\n',
    'lib/clip/a [DUET].txt':
      '#TITLE:T [DUET]\n#ARTIST:A\n#MP3:clip.mp4\n#VIDEO:clip.mp4\n#BPM:300\nP1\n: 0 1 0 la\nE\n',
    'lib/clip/clip.mp4': 'MP4',
    // Chanson normale : pas concernée
    'lib/ok/b.txt': '#TITLE:B\n#ARTIST:A\n#MP3:b.mp3\n#BPM:300\n: 0 1 0 la\nE\n',
    'lib/ok/b.mp3': 'MP3',
  });
  const songDir = path.join(library.root, 'lib');
  const catalog = createCatalog({ songDir, logger: silentLogger });
  await catalog.load();
  const ffmpeg = createFakeFfmpeg();
  const server = createApp(loadConfig({ ...env, BACKUP_DIR: path.join(library.root, 'backups') }), {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
    ffmpeg,
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const baseUrl = `http://127.0.0.1:${port}`;
  const write = { 'x-usm-request': '1' };
  return {
    songDir,
    catalog,
    ffmpeg,
    /** @param {unknown} body */
    post: (body, url = '/api/bulk/extract-audio') =>
      request(baseUrl, url, { method: 'POST', headers: write, body }),
    /** @param {string} [url] */
    get: (url = '/api/bulk/extract-audio') => request(baseUrl, url),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('/api/bulk/extract-audio', () => {
  it('simulation, lot (202), un MP3 créé puis réutilisé par le duo', async () => {
    const app = await setup({});
    try {
      assert.equal((await app.get()).json.data.batch, null);
      const dry = await app.post({ dryRun: true });
      assert.equal(dry.status, 200);
      assert.equal(dry.json.data.available, true);
      const items = dry.json.data.items;
      assert.equal(items.length, 2);
      assert.deepEqual(
        items.map((/** @type {any} */ i) => [i.file, i.target, i.reuse]),
        [
          ['clip/clip.mp4', 'clip.mp3', false],
          ['clip/clip.mp4', 'clip.mp3', false],
        ],
      );
      assert.deepEqual(app.ffmpeg.calls, []);

      const started = await app.post({
        items: items.map((/** @type {any} */ i) => ({
          id: i.id,
          expectedModifiedAt: i.modifiedAt,
        })),
      });
      assert.equal(started.status, 202);
      assert.equal(started.json.data.batch.kind, 'audio');
      let { batch } = started.json.data;
      while (batch.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        batch = (await app.get()).json.data.batch;
      }
      assert.equal(batch.state, 'done');
      assert.deepEqual(
        batch.items.map((/** @type {any} */ i) => i.status),
        ['converted', 'converted'],
      );
      // ffmpeg appelé une seule fois : le duo réutilise le MP3 créé pour le solo
      assert.equal(app.ffmpeg.calls.length, 1);
      assert.deepEqual(await readFile(path.join(app.songDir, 'clip/clip.mp3')), FAKE_MP3);
      for (const name of ['a.txt', 'a [DUET].txt']) {
        assert.match(
          await readFile(path.join(app.songDir, 'clip', name), 'utf8'),
          /#MP3:clip\.mp3\n/,
        );
      }
      assert.ok(
        !app.catalog.getSongs().some((s) => s.warnings.some((w) => w.code === 'VIDEO_IS_AUDIO')),
      );
      // Le lot audio n'apparaît pas comme lot vidéo
      assert.equal((await app.get('/api/bulk/convert-video')).json.data.batch, null);
      assert.equal(
        (await app.post({}, '/api/bulk/extract-audio/stop')).json.data.batch.state,
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
      assert.equal((await app.post({}, '/api/bulk/extract-audio/stop')).status, 403);
    } finally {
      await app.close();
    }
  });
});
