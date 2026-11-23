// @ts-check
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };

describe('GET /api/facet-images', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let covers;
  /** @type {import('node:http').Server} */
  let server;
  let baseUrl = '';

  before(async () => {
    covers = await createSongLibrary({
      'Language/French.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      'Decade/1990.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    });
    const facetImages = createFacetImages({ dir: covers.root, logger: silentLogger });
    await facetImages.load();
    const catalog = createCatalog({ songDir: null, logger: silentLogger });
    server = createApp(loadConfig({}), { catalog, facetImages }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await covers.cleanup();
  });

  it('liste les valeurs illustrées', async () => {
    const res = await fetch(`${baseUrl}/api/facet-images`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, {
      language: ['French'],
      decade: ['1990'],
      edition: [],
      tag: [],
    });
  });

  it('sert une image avec cache', async () => {
    const res = await fetch(`${baseUrl}/api/facet-images/language/french`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control') ?? '', /max-age=604800/);
  });

  it('404 FACET_IMAGE_NOT_FOUND pour une valeur inconnue ou un chemin piégé', async () => {
    for (const url of [
      '/api/facet-images/language/Klingon',
      '/api/facet-images/edition/..%2F..%2Fsecret',
    ]) {
      const res = await fetch(`${baseUrl}${url}`);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'FACET_IMAGE_NOT_FOUND');
    }
  });
});
