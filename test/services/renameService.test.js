// @ts-check
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { DEFAULT_NAMING } from '../../src/parsers/naming.js';
import { createCatalog } from '../../src/services/catalogService.js';
import { createRenamer } from '../../src/services/renameService.js';
import { SongEditError } from '../../src/services/songEditService.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {}, error() {} };
// Windows-1252 et CRLF : doivent être conservés
const SOLO = Buffer.from(
  '#TITLE:Été\r\n#ARTIST:Céline\r\n#MP3:ete.mp3\r\n#VIDEO:clip.mp4\r\n#COVER:cover.jpg\r\n' +
    '#BPM:300\r\n: 0 4 0 là\r\nE\r\n',
  'latin1',
);
const DUET =
  '#TITLE:Été [DUET]\n#ARTIST:Céline\n#P1:A\n#P2:B\n#MP3:ete.mp3\n#VIDEO:clip.mp4\n#BPM:300\n' +
  'P1\n: 0 4 0 là\nP2\n: 8 4 0 bas\nE\n';

describe('renameService', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let dir;
  /** @type {import('../../src/services/catalogService.js').Catalog} */
  let catalog;
  /** @type {import('../../src/services/renameService.js').Renamer} */
  let renamer;
  let songDir = '';
  let backupDir = '';

  beforeEach(async () => {
    await dir?.cleanup();
    dir = await createSongLibrary({
      'lib/Pop/ete-old/ete.txt': SOLO,
      'lib/Pop/ete-old/ete duo.txt': DUET,
      'lib/Pop/ete-old/ete.mp3': 'audio',
      'lib/Pop/ete-old/clip.mp4': 'video',
      'lib/Pop/ete-old/cover.jpg': 'image',
      'lib/Pop/ete-old/paroles.doc': 'autre',
    });
    songDir = path.join(dir.root, 'lib');
    backupDir = path.join(dir.root, 'backups');
    catalog = createCatalog({ songDir, logger: silentLogger });
    await catalog.load();
    renamer = createRenamer({
      catalog,
      songDir,
      backupDir,
      getNaming: () => DEFAULT_NAMING,
      logger: silentLogger,
    });
  });

  after(() => dir?.cleanup());

  const solo = () => {
    const song = catalog.getSongs().find((s) => !s.isDuet);
    assert.ok(song);
    return song;
  };
  /** @param {string} folder */
  const list = async (folder) => (await readdir(path.join(songDir, folder))).sort();

  it('simulation : plan du dossier, sans rien écrire', async () => {
    const plan = await renamer.preview(solo().id);
    assert.equal(plan.folder?.to, 'Céline - Été');
    assert.equal(plan.renameCount, 6); // dossier + 2 .txt + mp3 + mp4 + jpg
    assert.equal(plan.errorCount, 0);
    assert.deepEqual(
      plan.files.filter((f) => f.kind === 'other').map((f) => f.from),
      ['paroles.doc'],
    );
    assert.deepEqual(await list('Pop/ete-old'), [
      'clip.mp4',
      'cover.jpg',
      'ete duo.txt',
      'ete.mp3',
      'ete.txt',
      'paroles.doc',
    ]);
  });

  it('applique : fichiers, .txt et dossier renommés, encodage conservé, catalogue à jour', async () => {
    const plan = await renamer.preview(solo().id);
    const result = await renamer.apply(solo().id, { expected: plan.expected });
    assert.equal(result.renamed, 6);
    assert.deepEqual(await list('Pop/Céline - Été'), [
      'Céline - Été [CO].jpg',
      'Céline - Été [DUET].txt',
      'Céline - Été.mp3',
      'Céline - Été.mp4',
      'Céline - Été.txt',
      'paroles.doc',
    ]);
    const txt = await readFile(path.join(songDir, 'Pop/Céline - Été/Céline - Été.txt'));
    assert.deepEqual(
      txt,
      Buffer.from(
        '#TITLE:Été\r\n#ARTIST:Céline\r\n#MP3:Céline - Été.mp3\r\n#VIDEO:Céline - Été.mp4\r\n' +
          '#COVER:Céline - Été [CO].jpg\r\n#BPM:300\r\n: 0 4 0 là\r\nE\r\n',
        'latin1',
      ),
    );
    assert.equal(result.backups.length, 2);
    // Catalogue : nouveaux identifiants, plus d'avertissement de nommage
    const song = catalog.getSong(/** @type {string} */ (result.songId));
    assert.equal(song?.folder, 'Pop/Céline - Été');
    assert.equal(song?.txtFile, 'Céline - Été.txt');
    assert.deepEqual(
      catalog.getSongs().flatMap((s) => s.warnings.filter((w) => w.code.startsWith('NAMING_'))),
      [],
    );
    assert.equal(catalog.getSongs().length, 2);
  });

  it('noms saisis par l’utilisateur pris en compte', async () => {
    const overrides = {
      folder: 'ete-old2',
      files: { 'cover.jpg': 'Pochette [CO].jpg', 'paroles.doc': 'Céline - Été (paroles).doc' },
    };
    const plan = await renamer.preview(solo().id, { overrides });
    await renamer.apply(solo().id, { overrides, expected: plan.expected });
    const names = await list('Pop/ete-old2');
    assert.ok(names.includes('Pochette [CO].jpg'));
    assert.ok(names.includes('Céline - Été (paroles).doc'), 'fichier non cité renommé à la main');
  });

  it('refuse si le dossier a changé depuis la simulation, ou s’il reste un conflit', async () => {
    const plan = await renamer.preview(solo().id);
    await writeFile(path.join(songDir, 'Pop/ete-old/nouveau.png'), '');
    await assert.rejects(
      renamer.apply(solo().id, { expected: plan.expected }),
      (error) => error instanceof SongEditError && error.code === 'FOLDER_CHANGED',
    );
    const overrides = { files: { 'cover.jpg': 'a:b.jpg' } };
    const bad = await renamer.preview(solo().id, { overrides });
    assert.equal(bad.errorCount, 1);
    await assert.rejects(
      renamer.apply(solo().id, { overrides, expected: bad.expected }),
      (error) => error instanceof SongEditError && error.code === 'RENAME_CONFLICT',
    );
  });

  it('dossier cible déjà existant : conflit signalé', async () => {
    await mkdir(path.join(songDir, 'Pop/Céline - Été'));
    const plan = await renamer.preview(solo().id);
    assert.equal(plan.folder?.error, 'EXISTS');
  });

  it('échec en cours de route : tout est remis en place', async () => {
    const plan = await renamer.preview(solo().id);
    // Un dossier porte le nom final de la vidéo : le renommage échoue à cette étape.
    await mkdir(path.join(songDir, 'Pop/ete-old/Céline - Été.mp4'));
    await assert.rejects(
      renamer.apply(solo().id, { expected: plan.expected }),
      (error) => error instanceof SongEditError && error.code === 'RENAME_TARGET_EXISTS',
    );
    assert.deepEqual(await list('Pop/ete-old'), [
      'Céline - Été.mp4',
      'clip.mp4',
      'cover.jpg',
      'ete duo.txt',
      'ete.mp3',
      'ete.txt',
      'paroles.doc',
    ]);
    assert.deepEqual(await readFile(path.join(songDir, 'Pop/ete-old/ete.txt')), SOLO);
  });

  it('annulation : noms et contenus d’origine restaurés', async () => {
    const plan = await renamer.preview(solo().id);
    const { journal } = await renamer.apply(solo().id, { expected: plan.expected });
    assert.ok(journal);
    const { songIds } = await renamer.undo(journal);
    assert.equal(songIds.length, 2);
    assert.deepEqual(await list('Pop/ete-old'), [
      'clip.mp4',
      'cover.jpg',
      'ete duo.txt',
      'ete.mp3',
      'ete.txt',
      'paroles.doc',
    ]);
    assert.deepEqual(await readFile(path.join(songDir, 'Pop/ete-old/ete.txt')), SOLO);
    assert.equal(await readFile(path.join(songDir, 'Pop/ete-old/ete duo.txt'), 'utf8'), DUET);
    assert.equal(catalog.getSongs()[0].folder, 'Pop/ete-old');
    await assert.rejects(
      renamer.undo(journal),
      (error) => error instanceof SongEditError && error.code === 'RENAME_ALREADY_UNDONE',
    );
  });

  it('annulation refusée si un .txt a été modifié depuis, ou journal inconnu', async () => {
    const plan = await renamer.preview(solo().id);
    const { journal } = await renamer.apply(solo().id, { expected: plan.expected });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(songDir, 'Pop/Céline - Été/Céline - Été.txt'), 'modifié');
    await assert.rejects(
      renamer.undo(/** @type {string} */ (journal)),
      (error) => error instanceof SongEditError && error.code === 'FOLDER_CHANGED',
    );
    for (const id of ['../../etc', '2026-11-24T10-00-00-000Z-deadbeef']) {
      await assert.rejects(
        renamer.undo(id),
        (error) => error instanceof SongEditError && error.code === 'RENAME_NOT_FOUND',
      );
    }
  });
});
