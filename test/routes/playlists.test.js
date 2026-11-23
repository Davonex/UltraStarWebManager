// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary, songTxt } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ load?: boolean }} [options]
 */
async function startApp(env, { load = true } = {}) {
  const dir = await createSongLibrary({
    'songs/z/zen.txt': songTxt({ TITLE: 'Zen', ARTIST: 'Zazie', MP3: 'zen.mp3', BPM: '300' }),
    'playlists/top.upl': '#Name: Top\r\nZazie : Zen\r\nInconnu : X\r\n',
  });
  const catalog = createCatalog({ songDir: path.join(dir.root, 'songs'), logger: silentLogger });
  if (load) await catalog.load();
  const config = loadConfig({ ...env, PLAYLIST_DIR: path.join(dir.root, 'playlists') });
  const server = createApp(config, {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    catalog,
    get: () => request(`http://127.0.0.1:${port}`, '/api/playlists'),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await dir.cleanup();
    },
  };
}

describe('GET /api/playlists', () => {
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;
  before(async () => {
    app = await startApp({});
  });
  after(() => app.close());

  it('renvoie les playlists avec les chansons trouvées et les lignes introuvables', async () => {
    const res = await app.get();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.meta, { configured: true });
    assert.equal(typeof res.json.data[0].modifiedAt, 'number');
    assert.deepEqual(
      res.json.data.map((/** @type {any} */ { modifiedAt: _date, ...playlist }) => playlist),
      [
        {
          name: 'Top',
          file: 'top.upl',
          songIds: [app.catalog.getSongs()[0].id],
          missing: [{ artist: 'Inconnu', title: 'X' }],
        },
      ],
    );
  });
});

describe('GET /api/playlists — accès', () => {
  it('401 sans connexion (appareil du réseau, clé de lecture exigée)', async () => {
    const app = await startApp({ READ_KEY: 'lecture-123456', TRUST_LOCALHOST: 'false' });
    try {
      const res = await app.get();
      assert.equal(res.status, 401);
      assert.equal(res.json.error.code, 'AUTH_REQUIRED');
    } finally {
      await app.close();
    }
  });

  it('503 tant que le catalogue n’est pas chargé', async () => {
    const app = await startApp({}, { load: false });
    try {
      const res = await app.get();
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'CATALOG_LOADING');
    } finally {
      await app.close();
    }
  });
});
