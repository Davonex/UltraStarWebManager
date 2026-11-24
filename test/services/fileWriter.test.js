// @ts-check
import assert from 'node:assert/strict';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  backupFile,
  fileTimestamp,
  replaceFile,
  writeFileAtomic,
} from '../../src/services/fileWriter.js';
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

  /** Erreur Windows « fichier verrouillé ». */
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

  it('remplace un fichier ouvert par un lecteur (Windows) : ancien fichier écarté puis supprimé', async () => {
    const folder = path.join(dir.root, 'lib', 'Artiste - Titre');
    const target = path.join(folder, 'clip.mp4');
    const source = path.join(folder, '.clip.converting.mp4');
    await writeFile(target, 'ancienne');
    await writeFile(source, 'nouvelle');
    // Simule Windows : on ne peut pas écraser `target` tant qu'il est ouvert, mais on peut le renommer.
    /** @param {string} from @param {string} to */
    const renameFn = async (from, to) => {
      if (to === target && from === source && (await readdir(folder)).includes('clip.mp4')) {
        throw eperm();
      }
      await rename(from, to);
    };
    await replaceFile(source, target, { attempts: 1, renameFn });
    assert.equal(await readFile(target, 'utf8'), 'nouvelle');
    assert.deepEqual((await readdir(folder)).sort(), ['chanson.txt', 'clip.mp4']);
  });

  it('verrou complet : erreur, original et nouveau fichier intacts', async () => {
    const folder = path.join(dir.root, 'lib', 'Artiste - Titre');
    const target = path.join(folder, 'clip.mp4');
    const source = path.join(folder, '.clip.converting.mp4');
    await writeFile(target, 'ancienne');
    await writeFile(source, 'nouvelle');
    /** @param {string} from @param {string} to */
    const renameFn = async (from, to) => {
      if (from === target || to === target) throw eperm();
      await rename(from, to);
    };
    await assert.rejects(replaceFile(source, target, { attempts: 1, renameFn }), /EPERM/);
    assert.equal(await readFile(target, 'utf8'), 'ancienne');
    assert.equal(await readFile(source, 'utf8'), 'nouvelle');
  });
});
