// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { createCatalog } from '../../src/services/catalogService.js';
import {
  createSongEditor,
  normalizeHeaderValue,
  SongEditError,
} from '../../src/services/songEditService.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const UTF8_SONG =
  '#TITLE:Zen\n#ARTIST:Zazie\n#EDITION:Années 90\n#MP3:zen.mp3\n#BPM:300\n: 0 4 0 la\nE\n';
const CP1252_SONG = Buffer.from(
  '#TITLE:Été\r\n#ARTIST:Céline\r\n#MP3:ete.mp3\r\n#BPM:300\r\n: 0 4 0 là\r\nE\r\n',
  'latin1',
);

describe('normalizeHeaderValue', () => {
  it('nettoie une liste : espaces, vides et doublons (sans casse)', () => {
    assert.equal(normalizeHeaderValue('TAGS', ' Love Song ,, love song,  90s  '), 'Love Song, 90s');
    assert.equal(normalizeHeaderValue('TAGS', ' , '), null);
    assert.equal(normalizeHeaderValue('TAGS', null), null);
  });

  it('refuse un type invalide, un saut de ligne ou une valeur trop longue', () => {
    for (const value of [42, 'a\nb', 'x'.repeat(501)]) {
      assert.throws(() => normalizeHeaderValue('TAGS', value), SongEditError);
    }
  });
});

describe('songEditService', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let dir;
  /** @type {import('../../src/services/catalogService.js').Catalog} */
  let catalog;
  /** @type {import('../../src/services/songEditService.js').SongEditor} */
  let editor;
  let backupDir = '';

  beforeEach(async () => {
    await dir?.cleanup();
    dir = await createSongLibrary({
      'lib/Zazie - Zen/zen.txt': UTF8_SONG,
      'lib/Zazie - Zen/zen.mp3': '',
      'lib/Celine - Ete/ete.txt': CP1252_SONG,
      'lib/Celine - Ete/ete.mp3': '',
    });
    backupDir = path.join(dir.root, 'backups');
    catalog = createCatalog({ songDir: path.join(dir.root, 'lib'), logger: silentLogger });
    await catalog.load();
    editor = createSongEditor({ catalog, backupDir, logger: silentLogger });
  });
  after(() => dir.cleanup());

  /** @param {string} title */
  const songOf = (title) => {
    const song = catalog.getSongs().find((s) => s.title === title);
    assert.ok(song);
    return song;
  };

  it('modifie EDITION, ajoute TAGS et CREATOR, met le catalogue à jour', async () => {
    const zen = songOf('Zen');
    const result = await editor.editHeaders(zen.id, {
      values: { EDITION: 'Zazie', TAGS: 'love song, 90s', CREATOR: 'Davo' },
      expectedModifiedAt: zen.modifiedAt,
    });
    assert.deepEqual(
      result.changes.map((c) => `${c.header}:${c.before}→${c.after}`),
      ['EDITION:Années 90→Zazie', 'TAGS:null→love song, 90s', 'CREATOR:null→Davo'],
    );
    const text = await readFile(path.join(dir.root, 'lib/Zazie - Zen/zen.txt'), 'utf8');
    assert.equal(
      text,
      '#TITLE:Zen\n#ARTIST:Zazie\n#EDITION:Zazie\n#MP3:zen.mp3\n#BPM:300\n#TAGS:love song, 90s\n#CREATOR:Davo\n: 0 4 0 la\nE\n',
    );
    assert.deepEqual(result.song.editions, ['Zazie']);
    assert.deepEqual(catalog.getSong(zen.id)?.tags, ['love song', '90s']);
    assert.notEqual(catalog.getSong(zen.id)?.modifiedAt, undefined);
  });

  it('sauvegarde datée de l’original dans backups/', async () => {
    const zen = songOf('Zen');
    const { backup } = await editor.editHeaders(zen.id, {
      values: { EDITION: 'Zazie' },
      expectedModifiedAt: zen.modifiedAt,
    });
    assert.match(String(backup), /^Zazie - Zen\/zen\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.txt$/);
    assert.equal(await readFile(path.join(backupDir, String(backup)), 'utf8'), UTF8_SONG);
  });

  it('simulation : renvoie les changements sans rien écrire', async () => {
    const zen = songOf('Zen');
    const result = await editor.editHeaders(zen.id, {
      values: { EDITION: null },
      expectedModifiedAt: zen.modifiedAt,
      dryRun: true,
    });
    assert.deepEqual(result.changes, [{ header: 'EDITION', before: 'Années 90', after: null }]);
    assert.equal(await readFile(path.join(dir.root, 'lib/Zazie - Zen/zen.txt'), 'utf8'), UTF8_SONG);
    await assert.rejects(readdir(backupDir));
  });

  it('fichier Windows-1252 en CRLF : encodage et fins de ligne conservés', async () => {
    const ete = songOf('Été');
    assert.equal(ete.encoding, 'windows-1252');
    await editor.editHeaders(ete.id, {
      values: { TAGS: 'Été, Œuvre’s' },
      expectedModifiedAt: ete.modifiedAt,
    });
    const bytes = await readFile(path.join(dir.root, 'lib/Celine - Ete/ete.txt'));
    const expected = Buffer.concat([
      CP1252_SONG.subarray(0, CP1252_SONG.indexOf(': 0 4')),
      Buffer.from([
        ...Buffer.from('#TAGS:', 'latin1'),
        0xc9,
        0x74,
        0xe9,
        0x2c,
        0x20,
        0x8c,
        ...Buffer.from('uvre', 'latin1'),
        0x92,
        0x73,
        0x0d,
        0x0a,
      ]),
      CP1252_SONG.subarray(CP1252_SONG.indexOf(': 0 4')),
    ]);
    assert.deepEqual(bytes, expected);
  });

  it('refuse un caractère impossible à écrire en Windows-1252 (rien n’est écrit)', async () => {
    const ete = songOf('Été');
    await assert.rejects(
      editor.editHeaders(ete.id, {
        values: { TAGS: 'karaoké 🎤' },
        expectedModifiedAt: ete.modifiedAt,
      }),
      (error) => error instanceof SongEditError && error.code === 'UNENCODABLE_CHARACTER',
    );
    assert.deepEqual(await readFile(path.join(dir.root, 'lib/Celine - Ete/ete.txt')), CP1252_SONG);
  });

  it('refuse si le fichier a changé depuis son affichage (409)', async () => {
    const zen = songOf('Zen');
    await writeFile(path.join(dir.root, 'lib/Zazie - Zen/zen.txt'), `${UTF8_SONG}\n`);
    await assert.rejects(
      editor.editHeaders(zen.id, {
        values: { EDITION: 'X' },
        expectedModifiedAt: zen.modifiedAt - 5000,
      }),
      (error) =>
        error instanceof SongEditError && error.code === 'SONG_CHANGED' && error.status === 409,
    );
  });

  it('refuse un en-tête non modifiable ou une chanson inconnue', async () => {
    const zen = songOf('Zen');
    await assert.rejects(
      editor.editHeaders(zen.id, {
        values: { TITLE: 'Pirate' },
        expectedModifiedAt: zen.modifiedAt,
      }),
      (error) => error instanceof SongEditError && error.code === 'HEADER_NOT_EDITABLE',
    );
    await assert.rejects(
      editor.editHeaders('inconnu', { values: { TAGS: 'x' }, expectedModifiedAt: 0 }),
      (error) => error instanceof SongEditError && error.code === 'SONG_NOT_FOUND',
    );
  });

  it('aucun changement : rien n’est écrit ni sauvegardé', async () => {
    const zen = songOf('Zen');
    const result = await editor.editHeaders(zen.id, {
      values: { EDITION: ' Années 90 ' },
      expectedModifiedAt: zen.modifiedAt,
    });
    assert.deepEqual(result.changes, []);
    await assert.rejects(readdir(backupDir));
  });
});

describe('songEditService — conversion en UTF-8', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let dir;
  /** @type {import('../../src/services/catalogService.js').Catalog} */
  let catalog;
  /** @type {import('../../src/services/songEditService.js').SongEditor} */
  let editor;
  const BOM_SONG = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(UTF8_SONG.replace('Zen', 'Bom'), 'utf8'),
  ]);

  beforeEach(async () => {
    await dir?.cleanup();
    dir = await createSongLibrary({
      'lib/Zen/zen.txt': UTF8_SONG,
      'lib/Ete/ete.txt': CP1252_SONG,
      'lib/Bom/bom.txt': BOM_SONG,
    });
    catalog = createCatalog({ songDir: path.join(dir.root, 'lib'), logger: silentLogger });
    await catalog.load();
    editor = createSongEditor({
      catalog,
      backupDir: path.join(dir.root, 'backups'),
      logger: silentLogger,
    });
  });
  after(() => dir.cleanup());

  /** @param {string} title */
  const songOf = (title) => {
    const song = catalog.getSongs().find((s) => s.title === title);
    assert.ok(song);
    return song;
  };

  it('Windows-1252 → UTF-8 : même texte, CRLF conservés, sauvegarde, avertissement disparu', async () => {
    const ete = songOf('Été');
    assert.ok(ete.warnings.some((w) => w.code === 'ENCODING_NOT_UTF8'));
    const result = await editor.convertToUtf8(ete.id, { expectedModifiedAt: ete.modifiedAt });
    assert.equal(result.changed, true);
    assert.equal(result.from, 'windows-1252');
    const bytes = await readFile(path.join(dir.root, 'lib/Ete/ete.txt'));
    assert.deepEqual(bytes, Buffer.from(CP1252_SONG.toString('latin1'), 'utf8'));
    assert.equal(result.song.encoding, 'utf-8');
    assert.ok(!result.song.warnings.some((w) => w.code.startsWith('ENCODING')));
    assert.deepEqual(
      await readFile(path.join(dir.root, 'backups', String(result.backup))),
      CP1252_SONG,
    );
  });

  it('UTF-8 avec BOM → BOM retiré', async () => {
    const bom = songOf('Bom');
    await editor.convertToUtf8(bom.id, { expectedModifiedAt: bom.modifiedAt });
    assert.deepEqual(await readFile(path.join(dir.root, 'lib/Bom/bom.txt')), BOM_SONG.subarray(3));
  });

  it('déjà en UTF-8 : rien n’est écrit ; simulation : rien n’est écrit', async () => {
    const zen = songOf('Zen');
    const same = await editor.convertToUtf8(zen.id, { expectedModifiedAt: zen.modifiedAt });
    assert.deepEqual([same.changed, same.backup], [false, null]);
    const ete = songOf('Été');
    const dry = await editor.convertToUtf8(ete.id, {
      expectedModifiedAt: ete.modifiedAt,
      dryRun: true,
    });
    assert.deepEqual([dry.changed, dry.backup], [true, null]);
    assert.deepEqual(await readFile(path.join(dir.root, 'lib/Ete/ete.txt')), CP1252_SONG);
  });

  it('refuse si le fichier a changé depuis son affichage', async () => {
    const ete = songOf('Été');
    await assert.rejects(
      editor.convertToUtf8(ete.id, { expectedModifiedAt: 1 }),
      (error) => error instanceof SongEditError && error.code === 'SONG_CHANGED',
    );
  });
});

describe('songEditService — langue, genre, année et chanteurs', () => {
  it('chanteur : une seule valeur (virgules gardées) ; année : 4 chiffres', () => {
    assert.equal(
      normalizeHeaderValue('P1', '  Freddie  Mercury, Queen '),
      'Freddie Mercury, Queen',
    );
    assert.equal(normalizeHeaderValue('P2', ' '), null);
    assert.equal(normalizeHeaderValue('YEAR', ' 1985 '), '1985');
    assert.throws(() => normalizeHeaderValue('YEAR', '85'), SongEditError);
    assert.equal(normalizeHeaderValue('LANGUAGE', 'French, english, French'), 'French, english');
  });

  it('duo : met à jour #P1 / #P2, ou l’ancien #DUETSINGERP1 / #DUETSINGERP2 s’il est utilisé', async () => {
    const duet = (/** @type {string} */ singers) =>
      `#TITLE:Duo\n#ARTIST:A\n#MP3:a.mp3\n#BPM:300\n${singers}P1\n: 0 1 0 la\nP2\n: 2 1 0 la\nE\n`;
    const dir = await createSongLibrary({
      'lib/new/a.txt': duet('#P1:Anne\n#P2:Bob\n'),
      'lib/old/a.txt': duet('#DUETSINGERP1:Anne\n#DUETSINGERP2:Bob\n'),
    });
    try {
      const catalog = createCatalog({ songDir: path.join(dir.root, 'lib'), logger: silentLogger });
      await catalog.load();
      const editor = createSongEditor({
        catalog,
        backupDir: path.join(dir.root, 'backups'),
        logger: silentLogger,
      });
      for (const folder of ['new', 'old']) {
        const song = /** @type {any} */ (catalog.getSongs().find((s) => s.folder === folder));
        const { changes } = await editor.editHeaders(song.id, {
          values: { P1: 'Anne-Marie', LANGUAGE: 'French', YEAR: '1999' },
          expectedModifiedAt: song.modifiedAt,
        });
        assert.ok(changes.length === 3, folder);
        const text = await readFile(path.join(dir.root, 'lib', folder, 'a.txt'), 'utf8');
        assert.match(text, folder === 'new' ? /#P1:Anne-Marie\n/ : /#DUETSINGERP1:Anne-Marie\n/);
        assert.doesNotMatch(text, folder === 'new' ? /DUETSINGER/ : /^#P1:/m);
        assert.match(text, /#LANGUAGE:French\n/);
        assert.match(text, /#YEAR:1999\n/);
      }
    } finally {
      await dir.cleanup();
    }
  });
});
