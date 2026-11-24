// @ts-check
import assert from 'node:assert/strict';
import { chmod, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { request } from '../helpers/httpClient.js';
import { createSongLibrary, songTxt } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const TXT = songTxt({ TITLE: 'T', ARTIST: 'A', MP3: 'a.mp3', BPM: '300' });

// Un dossier en lecture seule simule un fichier verrouillé (sous Windows : synchronisation,
// antivirus, lecteur…). Ignoré si les tests tournent en administrateur (droits ignorés).
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('fichier verrouillé ou en lecture seule', {
  skip: isRoot || process.platform === 'win32',
}, () => {
  it('423 FILE_LOCKED (pas d’erreur interne), fichier intact, pas de fichier temporaire', async () => {
    const library = await createSongLibrary({ 'lib/s/a.txt': TXT, 'lib/s/a.mp3': '' });
    const folder = path.join(library.root, 'lib/s');
    try {
      const catalog = createCatalog({
        songDir: path.join(library.root, 'lib'),
        logger: silentLogger,
      });
      await catalog.load();
      const server = createApp(loadConfig({ BACKUP_DIR: path.join(library.root, 'backups') }), {
        catalog,
        facetImages: createFacetImages({ dir: null, logger: silentLogger }),
      }).listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const song = catalog.getSongs()[0];
      await chmod(folder, 0o555);
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        const res = await request(`http://127.0.0.1:${port}`, `/api/songs/${song.id}/headers`, {
          method: 'PATCH',
          headers: { 'x-usm-request': '1' },
          body: { values: { TAGS: 'Test' }, expectedModifiedAt: song.modifiedAt },
        });
        assert.equal(res.status, 423);
        assert.equal(res.json.error.code, 'FILE_LOCKED');
      } finally {
        console.warn = originalWarn;
        await new Promise((resolve) => server.close(resolve));
      }
      assert.equal(await readFile(path.join(folder, 'a.txt'), 'utf8'), TXT);
      assert.deepEqual((await readdir(folder)).sort(), ['a.mp3', 'a.txt']);
    } finally {
      await chmod(folder, 0o755);
      await library.cleanup();
    }
  });
});
