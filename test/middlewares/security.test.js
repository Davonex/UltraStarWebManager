// @ts-check
/**
 * Tests de sécurité de bout en bout : en-têtes, Host, origine des requêtes, connexion et rôles.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { requireRole } from '../../src/middlewares/auth.js';
import { MAX_FAILED_ATTEMPTS } from '../../src/services/authService.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { request, sessionCookie } from '../helpers/httpClient.js';
import { createSongLibrary, SAMPLE_LIBRARY } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const KEYS = {
  READ_KEY: 'lecture-123456',
  WRITE_KEY: 'ecriture-123456',
  ADMIN_KEY: 'admin-1234567',
};

/**
 * Démarre l'application avec la configuration donnée.
 * @param {NodeJS.ProcessEnv} env
 * @param {string | null} [songDir]
 */
async function startApp(env, songDir = null) {
  const catalog = createCatalog({ songDir, logger: silentLogger });
  await catalog.load();
  const facetImages = createFacetImages({ dir: null, logger: silentLogger });
  const server = createApp(loadConfig(env), { catalog, facetImages }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('sécurité — en-têtes et Host', () => {
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;
  before(async () => {
    app = await startApp({});
  });
  after(() => app.close());

  it('ajoute les en-têtes de sécurité (CSP stricte, anti-iframe…)', async () => {
    const res = await request(app.baseUrl, '/');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-security-policy']), /script-src 'self'/);
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('sert Bootstrap en local (plus de CDN)', async () => {
    const res = await request(app.baseUrl, '/vendor/bootstrap/css/bootstrap.min.css');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/css/);
  });

  it('refuse un en-tête Host inconnu (DNS rebinding)', async () => {
    const res = await request(app.baseUrl, '/api/health', {
      headers: { host: 'evil.example:3000' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'HOST_NOT_ALLOWED');
  });

  it('accepte localhost et [::1]', async () => {
    for (const host of ['localhost:3000', '[::1]:3000']) {
      const res = await request(app.baseUrl, '/api/health', { headers: { host } });
      assert.equal(res.status, 200, host);
    }
  });
});

describe('sécurité — API réservée à l’interface (anti-CSRF)', () => {
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;
  before(async () => {
    app = await startApp(KEYS);
  });
  after(() => app.close());

  it('refuse une requête envoyée depuis un autre site', async () => {
    /** @type {Record<string, string>[]} */
    const attacks = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example' },
      { origin: 'null' },
    ];
    for (const headers of attacks) {
      const res = await request(app.baseUrl, '/api/songs', { headers });
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(res.json.error.code, 'CROSS_ORIGIN_REQUEST');
    }
  });

  it('accepte notre propre page et une URL tapée à la main', async () => {
    const host = new URL(app.baseUrl).host;
    /** @type {Record<string, string>[]} */
    const legit = [
      { 'sec-fetch-site': 'same-origin', origin: `http://${host}` },
      { 'sec-fetch-site': 'none' },
    ];
    for (const headers of legit) {
      const res = await request(app.baseUrl, '/api/health', { headers });
      assert.equal(res.status, 200, JSON.stringify(headers));
    }
  });

  it('écriture : exige l’en-tête X-USM-Request et du JSON', async () => {
    const noHeader = await request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { key: 'x' },
    });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.json.error.code, 'CLIENT_HEADER_REQUIRED');

    const notJson = await request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'x-usm-request': '1', 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(notJson.status, 415);

    const badJson = await request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'x-usm-request': '1', 'content-type': 'application/json' },
    });
    assert.notEqual(badJson.status, 500);
  });
});

describe('sécurité — connexion et rôles (appareil du réseau)', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let library;
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;
  // TRUST_LOCALHOST=false : le test se comporte comme un appareil du réseau local.
  before(async () => {
    library = await createSongLibrary(SAMPLE_LIBRARY);
    app = await startApp({ ...KEYS, TRUST_LOCALHOST: 'false' }, library.root);
  });
  after(async () => {
    await app.close();
    await library.cleanup();
  });

  /** @param {string} key */
  const login = (key) =>
    request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { key },
    });

  it('sans connexion : 401 sur l’API, interface et santé accessibles', async () => {
    const songs = await request(app.baseUrl, '/api/songs');
    assert.equal(songs.status, 401);
    assert.equal(songs.json.error.code, 'AUTH_REQUIRED');
    assert.equal((await request(app.baseUrl, '/api/health')).status, 200);
    assert.equal((await request(app.baseUrl, '/')).status, 200);
    const me = await request(app.baseUrl, '/api/auth/me');
    assert.deepEqual(me.json.data, { role: null, isLocal: false, signedIn: false, hasKeys: true });
  });

  it('pochettes et audio aussi protégés', async () => {
    assert.equal((await request(app.baseUrl, '/api/songs/x/cover')).status, 401);
    assert.equal((await request(app.baseUrl, '/api/songs/x/audio')).status, 401);
    assert.equal((await request(app.baseUrl, '/api/songs/x/video')).status, 401);
    assert.equal((await request(app.baseUrl, '/api/facet-images')).status, 401);
  });

  it('mauvaise clé : 401 INVALID_KEY, sans cookie', async () => {
    const res = await login('pas-la-bonne-cle');
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'INVALID_KEY');
    assert.equal(sessionCookie(res.headers), '');
  });

  it('clé lecture : cookie HttpOnly SameSite=Strict, accès au catalogue', async () => {
    const res = await login(KEYS.READ_KEY);
    assert.equal(res.status, 200);
    assert.equal(res.json.data.role, 'read');
    const setCookie = String(res.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    const cookie = sessionCookie(res.headers);
    const songs = await request(app.baseUrl, '/api/songs', { headers: { cookie } });
    assert.equal(songs.status, 200);
    assert.equal(songs.json.data.length, 4);
    const me = await request(app.baseUrl, '/api/auth/me', { headers: { cookie } });
    assert.equal(me.json.data.role, 'read');
    assert.equal(me.json.data.signedIn, true);
  });

  it('cookie falsifié (rôle modifié) : refusé', async () => {
    const cookie = sessionCookie((await login(KEYS.READ_KEY)).headers).replace('=read.', '=admin.');
    const res = await request(app.baseUrl, '/api/songs', { headers: { cookie } });
    assert.equal(res.status, 401);
  });

  it('déconnexion : le cookie est effacé', async () => {
    const res = await request(app.baseUrl, '/api/auth/logout', {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: {},
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['set-cookie']), /usm_session=;/);
  });

  it('lien /login?key=… : pose le cookie et redirige sans la clé', async () => {
    const ok = await request(app.baseUrl, `/login?key=${KEYS.WRITE_KEY}`);
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/');
    assert.notEqual(sessionCookie(ok.headers), '');

    const ko = await request(app.baseUrl, '/login?key=mauvaise-cle-123');
    assert.equal(ko.status, 303);
    assert.equal(ko.headers.location, '/?login=INVALID_KEY');
  });
});

describe('sécurité — lecture publique (READ_KEY vide)', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let library;
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;
  before(async () => {
    library = await createSongLibrary(SAMPLE_LIBRARY);
    app = await startApp(
      { WRITE_KEY: KEYS.WRITE_KEY, ADMIN_KEY: KEYS.ADMIN_KEY, TRUST_LOCALHOST: 'false' },
      library.root,
    );
  });
  after(async () => {
    await app.close();
    await library.cleanup();
  });

  it('sans connexion : lecture autorisée à tous', async () => {
    const me = await request(app.baseUrl, '/api/auth/me');
    assert.deepEqual(me.json.data, {
      role: 'read',
      isLocal: false,
      signedIn: false,
      hasKeys: true,
    });
    const songs = await request(app.baseUrl, '/api/songs');
    assert.equal(songs.status, 200);
    assert.equal(songs.json.data.length, 4);
  });

  it('l’écriture et l’admin exigent toujours une clé', async () => {
    const login = await request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { key: KEYS.WRITE_KEY },
    });
    assert.equal(login.json.data.role, 'write');
    const me = await request(app.baseUrl, '/api/auth/me', {
      headers: { cookie: sessionCookie(login.headers) },
    });
    assert.equal(me.json.data.role, 'write');
    assert.equal(me.json.data.signedIn, true);
  });

  it('relire la bibliothèque exige le niveau écriture', async () => {
    const post = (/** @type {string} */ cookie) =>
      request(app.baseUrl, '/api/catalog/rescan', {
        method: 'POST',
        headers: { 'x-usm-request': '1', ...(cookie ? { cookie } : {}) },
        body: {},
      });
    const anonymous = await post('');
    assert.equal(anonymous.status, 403);
    assert.equal(anonymous.json.error.code, 'FORBIDDEN_ROLE');
    const login = await request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { key: KEYS.WRITE_KEY },
    });
    assert.equal((await post(sessionCookie(login.headers))).status, 200);
  });

  it('l’ancienne clé de lecture ne sert plus à rien', async () => {
    const login = await request(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'x-usm-request': '1' },
      body: { key: KEYS.READ_KEY },
    });
    assert.equal(login.status, 401);
  });
});

describe('sécurité — anti force brute', () => {
  it(`bloque après ${MAX_FAILED_ATTEMPTS} mauvaises clés, même avec la bonne ensuite`, async () => {
    const app = await startApp({ ...KEYS, TRUST_LOCALHOST: 'false' });
    try {
      const login = (/** @type {string} */ key) =>
        request(app.baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { 'x-usm-request': '1' },
          body: { key },
        });
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        assert.equal((await login(`mauvaise-${i}-xxxxx`)).status, 401);
      const blocked = await login(KEYS.ADMIN_KEY);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error.code, 'TOO_MANY_ATTEMPTS');
    } finally {
      await app.close();
    }
  });
});

describe('sécurité — ce PC (localhost de confiance)', () => {
  it('requête locale : admin sans clé', async () => {
    const app = await startApp(KEYS);
    try {
      const me = await request(app.baseUrl, '/api/auth/me');
      assert.deepEqual(me.json.data, {
        role: 'admin',
        isLocal: true,
        signedIn: false,
        hasKeys: true,
      });
      assert.equal((await request(app.baseUrl, '/api/songs')).status, 503); // pas de SONG_DIR, mais autorisé
    } finally {
      await app.close();
    }
  });
});

describe('requireRole — niveaux d’accès', () => {
  /** @param {import('../../src/config/index.js').Role | null} role */
  async function call(role, /** @type {import('../../src/config/index.js').Role} */ required) {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.role = role;
      next();
    });
    app.get('/x', requireRole(required), (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    try {
      return await request(`http://127.0.0.1:${port}`, '/x');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('lecture < écriture < admin', async () => {
    assert.equal((await call('read', 'read')).status, 200);
    assert.equal((await call('read', 'write')).status, 403);
    assert.equal((await call('write', 'write')).status, 200);
    assert.equal((await call('write', 'admin')).status, 403);
    assert.equal((await call('admin', 'admin')).status, 200);
    assert.equal((await call(null, 'read')).status, 401);
    const forbidden = await call('read', 'admin');
    assert.deepEqual(forbidden.json.error.params, { required: 'admin' });
  });
});
