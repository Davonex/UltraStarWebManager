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
import { encodeWindows1252 } from '../../src/utils/windows1252.js';
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
        values: { MP3: 'x.mp3' },
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

describe('songEditService — caractères mal encodés', () => {
  /** Texte UTF-8 relu en Windows-1252 : « é » → « Ã© ». */
  const garble = (/** @type {string} */ text) =>
    new TextDecoder('windows-1252').decode(Buffer.from(text, 'utf-8'));
  const GARBLED = `#TITLE:Lune ${garble('à')} Maubeuge\r\n#ARTIST:Bourvil\r\n#MP3:lune.mp3\r\n#BPM:300\r\n: 0 4 0 ${garble('l’été')}\r\nE\r\n`;
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let dir;
  /** @type {import('../../src/services/catalogService.js').Catalog} */
  let catalog;
  /** @type {import('../../src/services/songEditService.js').SongEditor} */
  let editor;

  beforeEach(async () => {
    await dir?.cleanup();
    dir = await createSongLibrary({
      'lib/Lune/lune.txt': GARBLED,
      'lib/Lune/lune.mp3': '',
      // Windows-1252 (« là » sur un octet) avec un titre mal encodé
      'lib/Cp/cp.txt': encodeWindows1252(
        `#TITLE:${garble('été')}\r\n#ARTIST:X\r\n#MP3:cp.mp3\r\n#BPM:300\r\n: 0 4 0 là\r\nE\r\n`,
      ),
      'lib/Cp/cp.mp3': '',
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

  /** @param {string} folder */
  const songIn = (folder) => {
    const song = catalog.getSongs().find((s) => s.folder === folder);
    assert.ok(song);
    return song;
  };

  it('simulation : liste les lignes, rien n’est écrit', async () => {
    const song = songIn('Lune');
    assert.ok(song.warnings.some((w) => w.code === 'ENCODING_MOJIBAKE'));
    const dry = await editor.repairText(song.id, {
      expectedModifiedAt: song.modifiedAt,
      dryRun: true,
    });
    assert.deepEqual(
      dry.changes.map((c) => [c.line, c.after]),
      [
        [1, '#TITLE:Lune à Maubeuge'],
        [5, ': 0 4 0 l’été'],
      ],
    );
    assert.equal(dry.backup, null);
    assert.equal(await readFile(path.join(dir.root, 'lib/Lune/lune.txt'), 'utf8'), GARBLED);
  });

  it('répare : CRLF conservés, sauvegarde, avertissement disparu, titre corrigé', async () => {
    const song = songIn('Lune');
    const result = await editor.repairText(song.id, { expectedModifiedAt: song.modifiedAt });
    assert.equal(
      await readFile(path.join(dir.root, 'lib/Lune/lune.txt'), 'utf8'),
      '#TITLE:Lune à Maubeuge\r\n#ARTIST:Bourvil\r\n#MP3:lune.mp3\r\n#BPM:300\r\n: 0 4 0 l’été\r\nE\r\n',
    );
    assert.equal(result.song.title, 'Lune à Maubeuge');
    assert.ok(!result.song.warnings.some((w) => w.code === 'ENCODING_MOJIBAKE'));
    assert.equal(
      await readFile(path.join(dir.root, 'backups', String(result.backup)), 'utf8'),
      GARBLED,
    );
  });

  it('fichier Windows-1252 : reste en Windows-1252', async () => {
    const song = songIn('Cp');
    const result = await editor.repairText(song.id, { expectedModifiedAt: song.modifiedAt });
    assert.equal(result.song.encoding, 'windows-1252');
    assert.equal(result.song.title, 'été');
    assert.deepEqual(
      await readFile(path.join(dir.root, 'lib/Cp/cp.txt')),
      encodeWindows1252(
        '#TITLE:été\r\n#ARTIST:X\r\n#MP3:cp.mp3\r\n#BPM:300\r\n: 0 4 0 là\r\nE\r\n',
      ),
    );
  });

  it('refuse si le fichier a changé depuis son affichage', async () => {
    const song = songIn('Lune');
    await assert.rejects(
      editor.repairText(song.id, { expectedModifiedAt: 1 }),
      (error) => error instanceof SongEditError && error.code === 'SONG_CHANGED',
    );
  });
});

describe('songEditService — artiste et titre', () => {
  const solo =
    '#TITLE:Le prix des allumettes\r\n#ARTIST:Stone et Charden\r\n#MP3:a.mp3\r\n#BPM:300\r\n: 0 4 0 la\r\nE\r\n';
  const duet =
    '#TITLE:Le prix des allumettes [DUET]\n#ARTIST:Stone et Charden\n#MP3:a.mp3\n#BPM:300\nP1\n: 0 4 0 la\nE\n';
  const other = '#TITLE:Autre\n#ARTIST:Stone et Charden\n#MP3:a.mp3\n#BPM:300\n: 0 4 0 la\nE\n';

  async function setup() {
    const dir = await createSongLibrary({
      'lib/sc/solo.txt': solo,
      'lib/sc/duo.txt': duet,
      'lib/sc/autre.txt': other,
      'lib/sc/a.mp3': '',
    });
    const catalog = createCatalog({ songDir: path.join(dir.root, 'lib'), logger: silentLogger });
    await catalog.load();
    /** @type {any[]} */
    const calls = [];
    const playlists = {
      /** @param {any} renames */
      async renameSongEntries(renames) {
        calls.push(renames);
        return { updated: [{ file: 'top.upl', backup: 'x' }], failed: [] };
      },
    };
    const editor = createSongEditor({
      catalog,
      backupDir: path.join(dir.root, 'backups'),
      playlists,
      logger: silentLogger,
    });
    /** @param {string} name */
    const read = (name) => readFile(path.join(dir.root, 'lib/sc', name), 'utf8');
    /** @param {string} txtFile */
    const songOf = (txtFile) => {
      const song = catalog.getSongs().find((s) => s.txtFile === txtFile);
      assert.ok(song);
      return song;
    };
    return { dir, editor, calls, read, songOf };
  }

  it('titre et artiste : solo modifié, duo suivi (marque gardée), autre chanson intacte, playlists', async () => {
    const app = await setup();
    try {
      const song = app.songOf('solo.txt');
      const result = await app.editor.editHeaders(song.id, {
        values: { ARTIST: 'Stone & Charden', TITLE: 'Le Prix des allumettes' },
        expectedModifiedAt: song.modifiedAt,
      });
      assert.equal(result.song.artist, 'Stone & Charden');
      assert.equal(
        await app.read('solo.txt'),
        '#TITLE:Le Prix des allumettes\r\n#ARTIST:Stone & Charden\r\n#MP3:a.mp3\r\n#BPM:300\r\n: 0 4 0 la\r\nE\r\n',
      );
      assert.match(
        await app.read('duo.txt'),
        /^#TITLE:Le Prix des allumettes \[DUET\]\n#ARTIST:Stone & Charden\n/,
      );
      assert.equal(await app.read('autre.txt'), other);
      assert.deepEqual(
        result.related?.updated.map((u) => u.txtFile),
        ['duo.txt'],
      );
      assert.deepEqual(result.playlists?.updated, [{ file: 'top.upl', backup: 'x' }]);
      assert.deepEqual(app.calls[0], [
        {
          from: { artist: 'Stone et Charden', title: 'Le prix des allumettes' },
          to: { artist: 'Stone & Charden', title: 'Le Prix des allumettes' },
        },
        {
          from: { artist: 'Stone et Charden', title: 'Le prix des allumettes [DUET]' },
          to: { artist: 'Stone & Charden', title: 'Le Prix des allumettes [DUET]' },
        },
      ]);
    } finally {
      await app.dir.cleanup();
    }
  });

  it('autre en-tête : ni propagation ni playlists ; artiste vide refusé', async () => {
    const app = await setup();
    try {
      const song = app.songOf('solo.txt');
      const result = await app.editor.editHeaders(song.id, {
        values: { YEAR: '1972' },
        expectedModifiedAt: song.modifiedAt,
      });
      assert.equal(result.related, undefined);
      assert.deepEqual(app.calls, []);
      assert.equal(await app.read('duo.txt'), duet);
      await assert.rejects(
        app.editor.editHeaders(song.id, { values: { ARTIST: '  ' }, expectedModifiedAt: 0 }),
        (error) => error instanceof SongEditError && error.code === 'VALUE_REQUIRED',
      );
    } finally {
      await app.dir.cleanup();
    }
  });
});

describe('songEditService — synchronisation (BPM, GAP, VIDEOGAP, preview, medley)', () => {
  it('nombres : point ou virgule, négatif seulement pour VIDEOGAP, BPM obligatoire', () => {
    assert.equal(normalizeHeaderValue('GAP', ' 12 345 '), '12345');
    assert.equal(normalizeHeaderValue('VIDEOGAP', '-1,5'), '-1.5');
    assert.equal(normalizeHeaderValue('PREVIEWSTART', ''), null);
    assert.equal(normalizeHeaderValue('MEDLEYSTARTBEAT', '395'), '395');
    for (const [header, value] of [
      ['GAP', '-10'],
      ['BPM', '0'],
      ['MEDLEYSTARTBEAT', '1.5'],
      ['VIDEOGAP', 'abc'],
      ['END', '1e5'],
    ]) {
      assert.throws(
        () => normalizeHeaderValue(header, value),
        (error) => error instanceof SongEditError && error.code === 'INVALID_NUMBER',
        `${header}=${value}`,
      );
    }
    assert.throws(
      () => normalizeHeaderValue('BPM', ''),
      (error) => error instanceof SongEditError && error.code === 'VALUE_REQUIRED',
    );
  });

  it('écrit en gardant la virgule du fichier ; medley : fin après le début', async () => {
    const text =
      '#TITLE:T\r\n#ARTIST:A\r\n#MP3:a.mp3\r\n#BPM:330,00\r\n#GAP:9000\r\n#MEDLEYSTARTBEAT:395\r\n' +
      '#MEDLEYENDBEAT:1105\r\n: 0 4 0 la\r\nE\r\n';
    const dir = await createSongLibrary({ 'lib/s/a.txt': text, 'lib/s/a.mp3': '' });
    try {
      const catalog = createCatalog({ songDir: path.join(dir.root, 'lib'), logger: silentLogger });
      await catalog.load();
      const editor = createSongEditor({
        catalog,
        backupDir: path.join(dir.root, 'backups'),
        logger: silentLogger,
      });
      let [song] = catalog.getSongs();
      const result = await editor.editHeaders(song.id, {
        values: { VIDEOGAP: '-0.4', GAP: '9100', PREVIEWSTART: '26.955' },
        expectedModifiedAt: song.modifiedAt,
      });
      assert.equal(result.song.videoGap, -0.4);
      assert.equal(
        await readFile(path.join(dir.root, 'lib/s/a.txt'), 'utf8'),
        '#TITLE:T\r\n#ARTIST:A\r\n#MP3:a.mp3\r\n#BPM:330,00\r\n#GAP:9100\r\n#MEDLEYSTARTBEAT:395\r\n' +
          '#MEDLEYENDBEAT:1105\r\n#VIDEOGAP:-0,4\r\n#PREVIEWSTART:26,955\r\n: 0 4 0 la\r\nE\r\n',
      );
      assert.ok(result.backup);
      [song] = catalog.getSongs();
      await assert.rejects(
        editor.editHeaders(song.id, {
          values: { MEDLEYENDBEAT: '300' },
          expectedModifiedAt: song.modifiedAt,
        }),
        (error) => error instanceof SongEditError && error.code === 'MEDLEY_ORDER',
      );
    } finally {
      await dir.cleanup();
    }
  });
});
