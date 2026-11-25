// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createMusicBrainz } from '../../src/services/musicBrainzService.js';
import { request } from '../helpers/httpClient.js';
import {
  ARTIST_ID,
  fakeMusicBrainzFetch,
  RECORDING_ID,
  RELEASE_GROUP_ID,
} from '../helpers/musicBrainzSamples.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const TXT =
  '#TITLE:Zen\r\n#ARTIST:Zazie\r\n#MP3:a.mp3\r\n#GENRE:Variété\r\n#BPM:300\r\n: 0 1 0 la\r\nE\r\n';

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    'lib/zen/a.txt': TXT,
    'lib/sans/a.txt': '#TITLE:Sans artiste\n#MP3:a.mp3\n#BPM:300\n: 0 1 0 la\nE\n',
  });
  const catalog = createCatalog({ songDir: path.join(library.root, 'lib'), logger: silentLogger });
  await catalog.load();
  const fetch = fakeMusicBrainzFetch();
  const server = createApp(loadConfig({ ...env, BACKUP_DIR: path.join(library.root, 'backups') }), {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
    musicBrainz: createMusicBrainz({ fetch, minIntervalMs: 0, logger: silentLogger }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  /** @param {string} title */
  const song = (title) => catalog.getSongs().find((s) => s.title === title);
  return {
    library,
    fetch,
    song,
    /** @param {string} url */
    get: (url) => request(base, url),
    /** @param {string} id @param {unknown} body */
    patch: (id, body) =>
      request(base, `/api/songs/${id}/headers`, {
        method: 'PATCH',
        headers: { 'x-usm-request': '1' },
        body,
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('MusicBrainz — routes', () => {
  it('recherche, proposition, puis application de YEAR / GENRE / LANGUAGE', async () => {
    const app = await setup({});
    try {
      const zen = /** @type {import('../../src/services/catalogService.js').Song} */ (
        app.song('Zen')
      );
      const found = await app.get(`/api/songs/${zen.id}/musicbrainz`);
      assert.equal(found.status, 200);
      assert.equal(found.json.data.candidates[0].id, RECORDING_ID);

      const query = `artistId=${ARTIST_ID}&releaseGroupId=${RELEASE_GROUP_ID}`;
      const suggested = await app.get(`/api/songs/${zen.id}/musicbrainz/${RECORDING_ID}?${query}`);
      assert.equal(suggested.status, 200);
      assert.equal(suggested.json.data.suggestion.year, 1995);
      assert.equal(suggested.json.data.suggestion.artist, 'Zazie');
      assert.equal(suggested.json.data.suggestion.title, 'Zen');

      // L'utilisateur garde l'année et la langue, et choisit un genre
      const saved = await app.patch(zen.id, {
        values: { YEAR: '1995', LANGUAGE: 'French', GENRE: 'Chanson française' },
        expectedModifiedAt: zen.modifiedAt,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      const text = await readFile(path.join(app.library.root, 'lib/zen/a.txt'), 'utf8');
      assert.match(text, /#GENRE:Chanson française\r\n/);
      assert.match(text, /#YEAR:1995\r\n/);
      assert.match(text, /#LANGUAGE:French\r\n/);
      const updated = app.song('Zen');
      assert.equal(updated?.year, 1995);
      assert.ok(!updated?.warnings.some((w) => w.code === 'MISSING_HEADER'));
    } finally {
      await app.close();
    }
  });

  it('refus : année invalide, identifiant MusicBrainz invalide, chanson sans artiste', async () => {
    const app = await setup({});
    try {
      const zen = /** @type {any} */ (app.song('Zen'));
      const bad = await app.patch(zen.id, {
        values: { YEAR: '95' },
        expectedModifiedAt: zen.modifiedAt,
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'INVALID_VALUE');
      for (const url of [
        `/api/songs/${zen.id}/musicbrainz/pas-un-id`,
        `/api/songs/${zen.id}/musicbrainz/${RECORDING_ID}?artistId=../../x`,
      ]) {
        assert.equal((await app.get(url)).status, 400, url);
      }
      const sans = /** @type {any} */ (app.song('Sans artiste'));
      const res = await app.get(`/api/songs/${sans.id}/musicbrainz`);
      assert.equal(res.status, 422);
      assert.equal(res.json.error.code, 'MUSICBRAINZ_NO_QUERY');
      assert.equal(app.fetch.calls.length, 0, 'aucun appel à MusicBrainz');
    } finally {
      await app.close();
    }
  });

  it('lecture publique : 403, aucun appel à MusicBrainz', async () => {
    const app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      const zen = /** @type {any} */ (app.song('Zen'));
      assert.equal((await app.get(`/api/songs/${zen.id}/musicbrainz`)).status, 403);
      assert.equal((await app.get(`/api/songs/${zen.id}/musicbrainz/${RECORDING_ID}`)).status, 403);
      assert.equal(app.fetch.calls.length, 0);
    } finally {
      await app.close();
    }
  });
});
