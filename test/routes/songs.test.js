// @ts-check
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createSongLibrary, SAMPLE_LIBRARY } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Démarre l'application sur un port libre.
 * @param {import('../../src/services/catalogService.js').Catalog} catalog
 */
async function startApp(catalog) {
  const facetImages = createFacetImages({ dir: null });
  const server = createApp(loadConfig({}), { catalog, facetImages }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('GET /api/songs', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let library;
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;

  before(async () => {
    library = await createSongLibrary(SAMPLE_LIBRARY);
    const catalog = createCatalog({ songDir: library.root, logger: silentLogger });
    await catalog.load();
    app = await startApp(catalog);
  });

  after(async () => {
    await app.close();
    await library.cleanup();
  });

  it('renvoie la liste des chansons et des métadonnées', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 4);
    assert.equal(body.meta.count, 4);
    assert.equal(body.meta.skipped, 1);
    assert.ok(body.meta.scannedAt);
    assert.equal(body.data[3].title, 'Zen');
  });
});

describe('GET /api/songs/:id/cover', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let library;
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;
  /** @type {import('../../src/services/catalogService.js').Catalog} */
  let catalog;

  before(async () => {
    library = await createSongLibrary({
      ...SAMPLE_LIBRARY,
      'Zazie - Zen/Zazie - Zen.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      'Zazie - Zen/Zazie - Zen.mp3': Buffer.from('ID3-0123456789'),
    });
    catalog = createCatalog({ songDir: library.root, logger: silentLogger });
    await catalog.load();
    app = await startApp(catalog);
  });

  after(async () => {
    await app.close();
    await library.cleanup();
  });

  /** @param {string} title */
  const idOf = (title) => catalog.getSongs().find((s) => s.title === title)?.id;

  it('renvoie l’image avec le bon type et un cache', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs/${idOf('Zen')}/cover`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control') ?? '', /max-age=604800/);
    assert.deepEqual(
      [...new Uint8Array(await res.arrayBuffer())],
      [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3],
    );
  });

  it('sert une pochette devinée par le marqueur [CO]', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs/${idOf("L'hymne à l'amour")}/cover`);
    assert.equal(res.status, 200);
  });

  it('404 SONG_NOT_FOUND pour un identifiant inconnu', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs/inconnu/cover`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'SONG_NOT_FOUND');
  });

  it('sert l’audio complet avec le bon type', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs/${idOf('Zen')}/audio`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(await res.text(), 'ID3-0123456789');
  });

  it('gère les requêtes partielles (Range) pour se positionner dans l’audio', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs/${idOf('Zen')}/audio`, {
      headers: { Range: 'bytes=4-7' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 4-7/14');
    assert.equal(await res.text(), '0123');
  });

  it('404 AUDIO_NOT_FOUND quand le fichier audio a disparu', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs/${idOf('Test (instru)')}/audio`);
    assert.equal(res.status, 200); // duo.mp3 existe
    const missing = catalog.getSongs().find((s) => s.title === 'Test');
    assert.ok(missing);
    const saved = missing.files.audio;
    missing.files.audio = null;
    try {
      const res404 = await fetch(`${app.baseUrl}/api/songs/${missing.id}/audio`);
      assert.equal(res404.status, 404);
      assert.equal((await res404.json()).error.code, 'AUDIO_NOT_FOUND');
    } finally {
      missing.files.audio = saved;
    }
  });

  it('404 COVER_NOT_FOUND pour une chanson sans pochette', async () => {
    const res = await fetch(`${app.baseUrl}/api/songs/${idOf('Test')}/cover`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'COVER_NOT_FOUND');
  });
});

describe('GET /api/songs — catalogue indisponible', () => {
  it('503 SONG_DIR_NOT_CONFIGURED sans SONG_DIR', async () => {
    const app = await startApp(createCatalog({ songDir: null, logger: silentLogger }));
    try {
      const res = await fetch(`${app.baseUrl}/api/songs`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'SONG_DIR_NOT_CONFIGURED');
    } finally {
      await app.close();
    }
  });

  it('503 CATALOG_UNAVAILABLE si le scan a échoué', async () => {
    const catalog = createCatalog({ songDir: '/dossier/inexistant', logger: silentLogger });
    await catalog.load();
    const app = await startApp(catalog);
    try {
      const res = await fetch(`${app.baseUrl}/api/songs`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'CATALOG_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });
});
