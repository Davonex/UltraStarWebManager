// @ts-check
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
/** @param {string} title */
const song = (title) =>
  `#TITLE:${title}\r\n#ARTIST:Été\r\n#MP3:a.mp3\r\n#BPM:300\r\n: 0 1 0 là\r\nE\r\n`;
const CP1 = Buffer.from(song('Un'), 'latin1');
const CP2 = Buffer.from(song('Deux'), 'latin1');
const BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(song('Trois'), 'utf8')]);
const UTF8 = Buffer.from(song('Quatre'), 'utf8');

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const dir = await createSongLibrary({
    'lib/1/a.txt': CP1,
    'lib/2/a.txt': CP2,
    'lib/3/a.txt': BOM,
    'lib/4/a.txt': UTF8,
  });
  const catalog = createCatalog({ songDir: path.join(dir.root, 'lib'), logger: silentLogger });
  await catalog.load();
  const config = loadConfig({ ...env, BACKUP_DIR: path.join(dir.root, 'backups') });
  const server = createApp(config, {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    dir,
    /** @param {unknown} body */
    post: (body) =>
      request(baseUrl, '/api/bulk/convert-utf8', {
        method: 'POST',
        headers: { 'x-usm-request': '1' },
        body,
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await dir.cleanup();
    },
  };
}

describe('POST /api/bulk/convert-utf8', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let app;
  before(async () => {
    app = await setup({});
  });
  after(() => app.close());

  it('simulation : liste les fichiers non UTF-8 sans rien écrire', async () => {
    const res = await app.post({ dryRun: true });
    assert.equal(res.status, 200);
    const items = res.json.data.items;
    assert.deepEqual(items.map((/** @type {any} */ i) => `${i.title}:${i.from}`).sort(), [
      'Deux:windows-1252',
      'Trois:utf-8-bom',
      'Un:windows-1252',
    ]);
    assert.deepEqual(await readFile(path.join(app.dir.root, 'lib/1/a.txt')), CP1);
  });

  it('application : convertit, ignore un fichier modifié entre-temps, continue après une erreur', async () => {
    const { items } = (await app.post({ dryRun: true })).json.data;
    const deux = items.find((/** @type {any} */ i) => i.title === 'Deux');
    // « Deux » est modifié ailleurs après la simulation : il doit être ignoré.
    await writeFile(
      path.join(app.dir.root, 'lib/2/a.txt'),
      Buffer.concat([CP2, Buffer.from('\r\n')]),
    );
    const touched = Date.now() + 10_000;
    const { utimes } = await import('node:fs/promises');
    await utimes(path.join(app.dir.root, 'lib/2/a.txt'), touched / 1000, touched / 1000);

    const res = await app.post({
      items: items.map((/** @type {any} */ i) => ({ id: i.id, expectedModifiedAt: i.modifiedAt })),
    });
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.json.data.results.map((/** @type {any} */ r) => [r.id, r]));
    assert.equal(byId[deux.id].status, 'error');
    assert.equal(byId[deux.id].code, 'SONG_CHANGED');
    const converted = res.json.data.results.filter(
      (/** @type {any} */ r) => r.status === 'converted',
    );
    assert.equal(converted.length, 2);
    assert.ok(converted.every((/** @type {any} */ r) => r.backup));

    assert.deepEqual(
      await readFile(path.join(app.dir.root, 'lib/1/a.txt')),
      Buffer.from(CP1.toString('latin1'), 'utf8'),
    );
    assert.deepEqual(await readFile(path.join(app.dir.root, 'lib/3/a.txt')), BOM.subarray(3));
    assert.deepEqual(await readFile(path.join(app.dir.root, 'lib/4/a.txt')), UTF8);
  });

  it('400 sans simulation ni éléments valides, ou avec trop d’éléments', async () => {
    for (const body of [
      {},
      { items: [] },
      { items: [{ id: 'x' }] },
      { items: Array.from({ length: 201 }, () => ({ id: 'x', expectedModifiedAt: 1 })) },
    ]) {
      assert.equal((await app.post(body)).status, 400);
    }
  });
});

describe('POST /api/bulk/convert-utf8 — lecture publique', () => {
  it('403, aucun fichier modifié', async () => {
    const app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      const res = await app.post({ dryRun: true });
      assert.equal(res.status, 403);
      assert.deepEqual(await readFile(path.join(app.dir.root, 'lib/1/a.txt')), CP1);
    } finally {
      await app.close();
    }
  });
});
