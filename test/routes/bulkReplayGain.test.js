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
// MP3 factice sans tag ReplayGain (trames + tag ID3v1)
const AUDIO = Buffer.concat([
  Buffer.alloc(3000, 0xfb),
  Buffer.from('TAG'),
  Buffer.alloc(125, 0x41),
]);

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    // Solo et duo sur le même MP3 : listé et calculé une seule fois
    'lib/a/solo.txt': '#TITLE:T\n#ARTIST:A\n#MP3:a.mp3\n#BPM:300\n: 0 1 0 la\nE\n',
    'lib/a/duo.txt': '#TITLE:T [DUET]\n#ARTIST:A\n#MP3:a.mp3\n#BPM:300\nP1\n: 0 1 0 la\nE\n',
    'lib/a/a.mp3': AUDIO,
    'lib/b/b.txt': '#TITLE:B\n#ARTIST:A\n#MP3:b.mp3\n#BPM:300\n: 0 1 0 la\nE\n',
    'lib/b/b.mp3': AUDIO,
  });
  const catalog = createCatalog({ songDir: path.join(library.root, 'lib'), logger: silentLogger });
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
    catalog,
    ffmpeg,
    /** @param {unknown} body */
    post: (body, url = '/api/bulk/replaygain') =>
      request(baseUrl, url, { method: 'POST', headers: write, body }),
    get: () => request(baseUrl, '/api/bulk/replaygain'),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('/api/bulk/replaygain', () => {
  it('simulation (un MP3 partagé listé une fois), lot (202), avertissements levés', async () => {
    const app = await setup({});
    try {
      assert.equal((await app.get()).json.data.batch, null);
      const dry = await app.post({ dryRun: true });
      assert.equal(dry.status, 200);
      const items = dry.json.data.items;
      assert.deepEqual(items.map((/** @type {any} */ i) => [i.file, i.sharedBy, i.size]).sort(), [
        ['a/a.mp3', 1, AUDIO.length],
        ['b/b.mp3', 0, AUDIO.length],
      ]);
      const started = await app.post({
        items: items.map((/** @type {any} */ i) => ({
          id: i.id,
          expectedAudioModifiedAt: i.audioModifiedAt,
        })),
      });
      assert.equal(started.status, 202);
      let { batch } = started.json.data;
      while (batch.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        batch = (await app.get()).json.data.batch;
      }
      assert.deepEqual(
        batch.items.map((/** @type {any} */ i) => [i.status, i.trackGain]),
        [
          ['converted', -2.54],
          ['converted', -2.54],
        ],
      );
      assert.equal(app.ffmpeg.calls.filter((c) => c.startsWith('replaygain:')).length, 2);
      // Le duo partage le MP3 : son avertissement disparaît aussi
      assert.ok(
        !app.catalog
          .getSongs()
          .some((s) => s.warnings.some((w) => w.code === 'REPLAYGAIN_MISSING')),
      );
      assert.deepEqual((await app.post({ dryRun: true })).json.data.items, []);
    } finally {
      await app.close();
    }
  });

  it('MP3 modifié depuis la simulation : ignoré (erreur), rien n’est écrit', async () => {
    const app = await setup({});
    try {
      const [item] = (await app.post({ dryRun: true })).json.data.items;
      const started = await app.post({
        items: [{ id: item.id, expectedAudioModifiedAt: item.audioModifiedAt - 5000 }],
      });
      let { batch } = started.json.data;
      while (batch.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        batch = (await app.get()).json.data.batch;
      }
      assert.deepEqual([batch.items[0].status, batch.items[0].code], ['error', 'SONG_CHANGED']);
      assert.equal(app.ffmpeg.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('400 pour un corps invalide ; lecture publique : 403 partout', async () => {
    const app = await setup({});
    try {
      for (const body of [{}, { items: [] }, { items: [{ id: 'x', expectedModifiedAt: 1 }] }]) {
        assert.equal((await app.post(body)).status, 400);
      }
    } finally {
      await app.close();
    }
    const locked = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      assert.equal((await locked.post({ dryRun: true })).status, 403);
      assert.equal((await locked.get()).status, 403);
      assert.equal((await locked.post({}, '/api/bulk/replaygain/stop')).status, 403);
    } finally {
      await locked.close();
    }
  });
});
