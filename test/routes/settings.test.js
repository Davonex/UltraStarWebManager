// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createSettings } from '../../src/services/settingsService.js';
import { request, sessionCookie } from '../helpers/httpClient.js';
import { createSongLibrary, songTxt } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    'lib/A - B/A - B.txt': songTxt({
      TITLE: 'B',
      ARTIST: 'A',
      MP3: 'A - B.mp3',
      COVER: 'A - B.jpg',
      BPM: '300',
    }),
    'lib/A - B/A - B.mp3': '',
    'lib/A - B/A - B.jpg': '',
  });
  const settings = createSettings({
    file: path.join(library.root, 'settings.json'),
    logger: silentLogger,
  });
  const catalog = createCatalog({
    songDir: path.join(library.root, 'lib'),
    logger: silentLogger,
    getNaming: () => settings.get().naming,
  });
  await catalog.load();
  const server = createApp(loadConfig({ ...env, BACKUP_DIR: path.join(library.root, 'backups') }), {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
    settings,
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  const coverWarned = () => catalog.getSongs()[0].warnings.some((w) => w.code === 'NAMING_COVER');
  return {
    base,
    coverWarned,
    get: () => request(base, '/api/settings'),
    /** @param {unknown} body @param {Record<string, string>} [headers] */
    put: (body, headers = {}) =>
      request(base, '/api/settings', {
        method: 'PUT',
        headers: { 'x-usm-request': '1', ...headers },
        body,
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('/api/settings', () => {
  it('lecture, puis modification : la bibliothèque est relue avec les nouveaux modèles', async () => {
    const app = await setup({});
    try {
      const { data } = (await app.get()).json;
      assert.equal(data.naming.cover.pattern, '{artist} - {title} [CO]');
      assert.equal(app.coverWarned(), true, 'pochette sans [CO]');

      const res = await app.put({
        naming: { ...data.naming, cover: { enabled: true, pattern: '{artist} - {title}' } },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.naming.cover.pattern, '{artist} - {title}');
      assert.equal(app.coverWarned(), false, 'avertissement levé après relecture');

      const bad = await app.put({ naming: { cover: { enabled: true, pattern: 'x' } } });
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.json.error.params, { kind: 'cover', reason: 'PATTERN_NO_PLACEHOLDER' });
    } finally {
      await app.close();
    }
  });

  it('modification réservée à l’admin : 403 avec la clé écriture', async () => {
    const app = await setup({
      WRITE_KEY: 'ecriture-123456',
      ADMIN_KEY: 'admin-1234567890',
      TRUST_LOCALHOST: 'false',
    });
    try {
      const login = await request(app.base, '/api/auth/login', {
        method: 'POST',
        headers: { 'x-usm-request': '1' },
        body: { key: 'ecriture-123456' },
      });
      const cookie = sessionCookie(login.headers);
      assert.equal((await request(app.base, '/api/settings', { headers: { cookie } })).status, 200);
      const res = await app.put({ naming: {} }, { cookie });
      assert.equal(res.status, 403);
      assert.equal(app.coverWarned(), true);
    } finally {
      await app.close();
    }
  });
});
