// @ts-check
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { request, sessionCookie } from '../helpers/httpClient.js';
import { createSongLibrary, songTxt } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    'lib/old/a.txt': songTxt({ TITLE: 'B', ARTIST: 'A', MP3: 'a.mp3', COVER: 'a.jpg', BPM: '300' }),
    'lib/old/a.mp3': '',
    'lib/old/a.jpg': '',
  });
  const songDir = path.join(library.root, 'lib');
  const catalog = createCatalog({ songDir, logger: silentLogger });
  await catalog.load();
  const config = loadConfig({
    ...env,
    SONG_DIR: songDir,
    BACKUP_DIR: path.join(library.root, 'backups'),
    SETTINGS_FILE: path.join(library.root, 'settings.json'),
  });
  const server = createApp(config, {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    songDir,
    songId: () => catalog.getSongs()[0].id,
    /** @param {string} url @param {unknown} body @param {Record<string, string>} [headers] */
    post: (url, body, headers = {}) =>
      request(base, url, { method: 'POST', headers: { 'x-usm-request': '1', ...headers }, body }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('/api/songs/:id/rename', () => {
  it('simulation, application puis annulation', async () => {
    const app = await setup({});
    try {
      const preview = await app.post(`/api/songs/${app.songId()}/rename`, { dryRun: true });
      assert.equal(preview.status, 200);
      const plan = preview.json.data;
      assert.equal(plan.folder.to, 'A - B');
      assert.equal(plan.renameCount, 4);
      assert.equal(plan.txts[0].changes.length, 2);

      const applied = await app.post(`/api/songs/${app.songId()}/rename`, {
        expected: plan.expected,
      });
      assert.equal(applied.status, 200);
      assert.equal(applied.json.data.songId, app.songId());
      assert.deepEqual((await readdir(path.join(app.songDir, 'A - B'))).sort(), [
        'A - B [CO].jpg',
        'A - B.mp3',
        'A - B.txt',
      ]);

      const again = await app.post(`/api/songs/${app.songId()}/rename`, {
        expected: plan.expected,
      });
      assert.equal(again.status, 409, 'état de la simulation périmé');

      const undo = await app.post(`/api/renames/${applied.json.data.journal}/undo`, {});
      assert.equal(undo.status, 200);
      assert.deepEqual((await readdir(path.join(app.songDir, 'old'))).sort(), [
        'a.jpg',
        'a.mp3',
        'a.txt',
      ]);
    } finally {
      await app.close();
    }
  });

  it('requête invalide → 400, chanson inconnue → 404', async () => {
    const app = await setup({});
    try {
      const url = `/api/songs/${app.songId()}/rename`;
      for (const body of [
        { dryRun: 'oui' },
        { dryRun: true, overrides: { files: { 'a.mp3': 42 } } },
        { dryRun: true, overrides: [] },
        {},
      ]) {
        assert.equal((await app.post(url, body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await app.post('/api/songs/inconnu/rename', { dryRun: true })).status, 404);
    } finally {
      await app.close();
    }
  });

  it('réservé au niveau écriture : 403 en lecture seule', async () => {
    const app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      const res = await app.post(`/api/songs/${app.songId()}/rename`, { dryRun: true });
      assert.equal(res.status, 403);
      const undo = await app.post('/api/renames/x/undo', {});
      assert.equal(undo.status, 403);
      // Avec la clé écriture : accepté
      const login = await request(app.base, '/api/auth/login', {
        method: 'POST',
        headers: { 'x-usm-request': '1' },
        body: { key: 'ecriture-123456' },
      });
      const cookie = sessionCookie(login.headers);
      const ok = await app.post(`/api/songs/${app.songId()}/rename`, { dryRun: true }, { cookie });
      assert.equal(ok.status, 200);
    } finally {
      await app.close();
    }
  });
});
