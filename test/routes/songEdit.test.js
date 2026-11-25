// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { request, sessionCookie } from '../helpers/httpClient.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const SONG = '#TITLE:Zen\n#ARTIST:Zazie\n#MP3:zen.mp3\n#BPM:300\n: 0 4 0 la\nE\n';

/**
 * @param {NodeJS.ProcessEnv} env
 */
async function setup(env) {
  const dir = await createSongLibrary({ 'lib/Zen/zen.txt': SONG, 'lib/Zen/zen.mp3': '' });
  const catalog = createCatalog({ songDir: path.join(dir.root, 'lib'), logger: silentLogger });
  await catalog.load();
  const facetImages = createFacetImages({ dir: null, logger: silentLogger });
  const config = loadConfig({ ...env, BACKUP_DIR: path.join(dir.root, 'backups') });
  const server = createApp(config, { catalog, facetImages }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const song = catalog.getSongs()[0];
  return {
    dir,
    song,
    baseUrl: `http://127.0.0.1:${port}`,
    /** @param {unknown} body @param {Record<string, string>} [headers] */
    patch: (body, headers = {}) =>
      request(`http://127.0.0.1:${port}`, `/api/songs/${song.id}/headers`, {
        method: 'PATCH',
        headers: { 'x-usm-request': '1', ...headers },
        body,
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await dir.cleanup();
    },
  };
}

describe('PATCH /api/songs/:id/headers — sur ce PC (admin)', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let app;
  before(async () => {
    app = await setup({});
  });
  after(() => app.close());

  it('simulation puis enregistrement', async () => {
    const dry = await app.patch({
      values: { TAGS: 'slow' },
      expectedModifiedAt: app.song.modifiedAt,
      dryRun: true,
    });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.json.data.changes, [{ header: 'TAGS', before: null, after: 'slow' }]);
    assert.equal(dry.json.data.backup, null);

    const saved = await app.patch({
      values: { TAGS: 'slow' },
      expectedModifiedAt: app.song.modifiedAt,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.data.song.tags, ['slow']);
    assert.ok(saved.json.data.backup);
    assert.match(await readFile(path.join(app.dir.root, 'lib/Zen/zen.txt'), 'utf8'), /#TAGS:slow/);
  });

  it('conversion UTF-8 : fichier déjà en UTF-8, rien à faire ; corps invalide : 400', async () => {
    // Date de modification à jour (le test précédent a modifié le fichier)
    const { modifiedAt } = (await request(app.baseUrl, '/api/songs')).json.data[0];
    const ok = await request(app.baseUrl, `/api/songs/${app.song.id}/convert-utf8`, {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { expectedModifiedAt: modifiedAt },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.changed, false);
    const bad = await request(app.baseUrl, `/api/songs/${app.song.id}/convert-utf8`, {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: {},
    });
    assert.equal(bad.status, 400);
  });

  it('réparation du texte : rien à réparer ; corps invalide : 400', async () => {
    const { modifiedAt } = (await request(app.baseUrl, '/api/songs')).json.data[0];
    const ok = await request(app.baseUrl, `/api/songs/${app.song.id}/repair-text`, {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { expectedModifiedAt: modifiedAt, dryRun: true },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.data.changes, []);
    const bad = await request(app.baseUrl, `/api/songs/${app.song.id}/repair-text`, {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { expectedModifiedAt: modifiedAt, dryRun: 'oui' },
    });
    assert.equal(bad.status, 400);
  });

  it('409 si la date de modification ne correspond plus', async () => {
    const res = await app.patch({ values: { TAGS: 'x' }, expectedModifiedAt: 1 });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'SONG_CHANGED');
  });

  it('400 pour un corps invalide ou un en-tête non modifiable', async () => {
    for (const body of [
      {},
      { values: {}, expectedModifiedAt: 1 },
      { values: { TAGS: 'x' } },
      { values: [], expectedModifiedAt: 1 },
    ]) {
      assert.equal((await app.patch(body)).status, 400, JSON.stringify(body));
    }
    const res = await app.patch({ values: { BPM: '120' }, expectedModifiedAt: 1 });
    assert.equal(res.json.error.code, 'HEADER_NOT_EDITABLE');
  });

  it('403 sans l’en-tête X-USM-Request (anti-CSRF)', async () => {
    const res = await request(app.baseUrl, `/api/songs/${app.song.id}/headers`, {
      method: 'PATCH',
      body: { values: { TAGS: 'x' }, expectedModifiedAt: app.song.modifiedAt },
    });
    assert.equal(res.status, 403);
  });
});

describe('PATCH /api/songs/:id/headers — appareil du réseau', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let app;
  before(async () => {
    app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
  });
  after(() => app.close());

  it('lecture publique : 403, le fichier n’est pas modifié', async () => {
    const res = await app.patch({ values: { TAGS: 'x' }, expectedModifiedAt: app.song.modifiedAt });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'FORBIDDEN_ROLE');
    assert.equal(await readFile(path.join(app.dir.root, 'lib/Zen/zen.txt'), 'utf8'), SONG);
  });

  it('conversion UTF-8 : 403 en lecture publique', async () => {
    const res = await request(app.baseUrl, `/api/songs/${app.song.id}/convert-utf8`, {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { expectedModifiedAt: app.song.modifiedAt },
    });
    assert.equal(res.status, 403);
  });

  it('réparation du texte : 403 en lecture publique', async () => {
    const res = await request(app.baseUrl, `/api/songs/${app.song.id}/repair-text`, {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { expectedModifiedAt: app.song.modifiedAt },
    });
    assert.equal(res.status, 403);
  });

  it('avec la clé écriture : autorisé', async () => {
    const login = await request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { key: 'ecriture-123456' },
    });
    const res = await app.patch(
      { values: { CREATOR: 'Davo' }, expectedModifiedAt: app.song.modifiedAt },
      { cookie: sessionCookie(login.headers) },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.song.creators, ['Davo']);
  });
});
