// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary, songTxt } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
// Playlist en Windows-1252 avec fins de ligne CRLF : les deux doivent être conservés.
const UPL = Buffer.from('#Name: Soirée\r\nZazie : Zen\r\n', 'latin1');

/** @param {NodeJS.ProcessEnv} env */
async function setup(env) {
  const library = await createSongLibrary({
    'songs/zen/zen.txt': songTxt({ TITLE: 'Zen', ARTIST: 'Zazie', MP3: 'zen.mp3', BPM: '300' }),
    'songs/piaf/piaf.txt': songTxt({
      TITLE: "L'hymne à l'amour",
      ARTIST: 'Édith Piaf',
      MP3: 'p.mp3',
      BPM: '300',
    }),
    'playlists/soiree.upl': UPL,
  });
  const catalog = createCatalog({
    songDir: path.join(library.root, 'songs'),
    logger: silentLogger,
  });
  await catalog.load();
  const config = loadConfig({
    ...env,
    PLAYLIST_DIR: path.join(library.root, 'playlists'),
    BACKUP_DIR: path.join(library.root, 'backups'),
  });
  const server = createApp(config, {
    catalog,
    facetImages: createFacetImages({ dir: null, logger: silentLogger }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  const uplPath = path.join(library.root, 'playlists/soiree.upl');
  /** @param {string} title */
  const idOf = (title) =>
    /** @type {string} */ (catalog.getSongs().find((s) => s.title === title)?.id);
  return {
    library,
    uplPath,
    idOf,
    list: () => request(base, '/api/playlists'),
    /** @param {'POST' | 'DELETE'} method @param {string} file @param {unknown} body */
    change: (method, file, body) =>
      request(base, `/api/playlists/${encodeURIComponent(file)}/songs`, {
        method,
        headers: { 'x-usm-request': '1' },
        body,
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await library.cleanup();
    },
  };
}

describe('POST / DELETE /api/playlists/:file/songs', () => {
  it('ajoute puis retire une chanson : encodage, fins de ligne et sauvegardes', async () => {
    const app = await setup({});
    try {
      const [playlist] = (await app.list()).json.data;
      const piaf = app.idOf("L'hymne à l'amour");

      const added = await app.change('POST', 'soiree.upl', {
        songId: piaf,
        expectedModifiedAt: playlist.modifiedAt,
      });
      assert.equal(added.status, 200, JSON.stringify(added.json));
      assert.equal(added.json.data.changed, true);
      assert.ok(added.json.data.playlist.songIds.includes(piaf));
      assert.deepEqual(
        await readFile(app.uplPath),
        Buffer.concat([UPL, Buffer.from("Édith Piaf : L'hymne à l'amour\r\n", 'latin1')]),
      );

      // Déjà présente : rien n'est écrit
      const again = await app.change('POST', 'soiree.upl', {
        songId: piaf,
        expectedModifiedAt: added.json.data.playlist.modifiedAt,
      });
      assert.equal(again.json.data.changed, false);
      assert.equal(again.json.data.backup, null);

      const removed = await app.change('DELETE', 'soiree.upl', {
        songId: piaf,
        expectedModifiedAt: again.json.data.playlist.modifiedAt,
      });
      assert.equal(removed.json.data.changed, true);
      assert.deepEqual(await readFile(app.uplPath), UPL);

      // Une sauvegarde datée par écriture, à part des dossiers de chansons
      const backups = await readdir(path.join(app.library.root, 'backups/_playlists'));
      assert.equal(backups.length, 2);
    } finally {
      await app.close();
    }
  });

  it('refuse si la playlist a changé depuis son affichage (409)', async () => {
    const app = await setup({});
    try {
      const [playlist] = (await app.list()).json.data;
      await writeFile(app.uplPath, Buffer.concat([UPL, Buffer.from('X : Y\r\n')]));
      const res = await app.change('POST', 'soiree.upl', {
        songId: app.idOf('Zen'),
        expectedModifiedAt: playlist.modifiedAt - 10_000,
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'PLAYLIST_CHANGED');
    } finally {
      await app.close();
    }
  });

  it('refuse un fichier hors du dossier ou qui n’est pas un .upl', async () => {
    const app = await setup({});
    try {
      for (const file of ['../songs/zen/zen.txt', '..\\x.upl', 'notes.txt', 'absente.upl']) {
        const res = await app.change('POST', file, {
          songId: app.idOf('Zen'),
          expectedModifiedAt: 1,
        });
        assert.equal(res.status, 404, file);
        assert.equal(res.json.error.code, 'PLAYLIST_NOT_FOUND', file);
      }
      const bad = await app.change('POST', 'soiree.upl', { songId: 42 });
      assert.equal(bad.status, 400);
      assert.deepEqual(await readFile(app.uplPath), UPL);
    } finally {
      await app.close();
    }
  });

  it('lecture publique : liste permise, modification refusée (403)', async () => {
    const app = await setup({ WRITE_KEY: 'ecriture-123456', TRUST_LOCALHOST: 'false' });
    try {
      assert.equal((await app.list()).status, 200);
      for (const method of /** @type {const} */ (['POST', 'DELETE'])) {
        const res = await app.change(method, 'soiree.upl', {
          songId: app.idOf('Zen'),
          expectedModifiedAt: 1,
        });
        assert.equal(res.status, 403);
      }
      assert.deepEqual(await readFile(app.uplPath), UPL);
    } finally {
      await app.close();
    }
  });
});
