// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { backupFile, fileTimestamp, writeFileAtomic } from '../../src/services/fileWriter.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

describe('fileWriter', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let dir;
  before(async () => {
    dir = await createSongLibrary({
      'lib/Artiste - Titre/chanson.txt': 'original',
      'backups/.keep': '',
    });
  });
  after(() => dir.cleanup());

  it('horodatage compatible avec les noms de fichiers Windows', () => {
    assert.equal(fileTimestamp(new Date('2026-11-21T10:30:00.123Z')), '2026-11-21T10-30-00-123Z');
  });

  it('sauvegarde datée, chemin de la bibliothèque reproduit, historique conservé', async () => {
    const file = path.join(dir.root, 'lib', 'Artiste - Titre', 'chanson.txt');
    const backupDir = path.join(dir.root, 'backups');
    const first = await backupFile({
      file,
      relativePath: 'Artiste - Titre/chanson.txt',
      backupDir,
      date: new Date('2026-11-21T10:30:00.000Z'),
    });
    assert.equal(first, 'Artiste - Titre/chanson.2026-11-21T10-30-00-000Z.txt');
    assert.equal(await readFile(path.join(backupDir, first), 'utf8'), 'original');

    await writeFile(file, 'modifié');
    await backupFile({
      file,
      relativePath: 'Artiste - Titre/chanson.txt',
      backupDir,
      date: new Date('2026-11-21T11:00:00.000Z'),
    });
    assert.equal((await readdir(path.join(backupDir, 'Artiste - Titre'))).length, 2);
  });

  it('refuse une sauvegarde hors du dossier de sauvegardes', async () => {
    await assert.rejects(
      backupFile({
        file: path.join(dir.root, 'lib', 'Artiste - Titre', 'chanson.txt'),
        relativePath: '../../evil.txt',
        backupDir: path.join(dir.root, 'backups'),
      }),
      /outside/,
    );
  });

  it('écriture atomique : contenu remplacé, aucun fichier temporaire restant', async () => {
    const file = path.join(dir.root, 'lib', 'Artiste - Titre', 'chanson.txt');
    await writeFileAtomic(file, Buffer.from('nouveau'));
    assert.equal(await readFile(file, 'utf8'), 'nouveau');
    assert.deepEqual(await readdir(path.dirname(file)), ['chanson.txt']);
  });
});
