// @ts-check
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createCatalog } from '../src/services/catalogService.js';
import { createFacetImages } from '../src/services/facetImageService.js';

describe('API', () => {
  /** @type {import('node:http').Server} */
  let server;
  let baseUrl = '';

  before(async () => {
    const app = createApp(loadConfig({}), {
      catalog: createCatalog({ songDir: null }),
      facetImages: createFacetImages({ dir: null }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('GET /api/health répond ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  it('route API inconnue → 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/nexiste-pas`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'ROUTE_NOT_FOUND');
  });

  it('sert les fichiers de langue', async () => {
    const res = await fetch(`${baseUrl}/locales/fr.json`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).nav.language, 'Langue');
  });

  it('sert le favicon (SVG et .ico de secours)', async () => {
    const svg = await fetch(`${baseUrl}/img/favicon.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/);
    const ico = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(ico.status, 200);
    // En-tête ICO : réservé 0, type 1 (icône)
    const bytes = new Uint8Array(await ico.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0, 0, 1, 0]);
  });

  it('sert la page d’accueil', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /UltraStarWebManager/);
  });
});
