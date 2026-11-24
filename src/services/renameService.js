// @ts-check
/**
 * Renommage d'un dossier de chanson selon les normes de nommage (préférences).
 *
 * Étapes de l'application :
 * 1. vérifie que le dossier n'a pas changé depuis la simulation (liste des fichiers, dates des .txt) ;
 * 2. sauvegarde datée de chaque .txt dont le contenu change ;
 * 3. renomme les fichiers en deux temps (nom temporaire, puis nom final) : un échange de noms
 *    ou un simple changement de majuscules marche aussi sous Windows ;
 * 4. réécrit les .txt (en-têtes #MP3, #VIDEO, #COVER… corrigés, encodage d'origine conservé) ;
 * 5. renomme le dossier en dernier ;
 * 6. note l'opération dans un journal (dossier de sauvegardes) pour pouvoir l'annuler.
 *
 * Si une étape échoue (fichier verrouillé…), tout ce qui a déjà été fait est défait.
 *
 * @module services/renameService
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRenamePlan } from '../parsers/renamePlan.js';
import { encodeSongText } from '../parsers/ultrastarEdit.js';
import { decodeSongBuffer, parseUltrastarTxt } from '../parsers/ultrastarTxt.js';
import { resolveInside } from '../utils/safePath.js';
import { fileNameKey } from '../utils/text.js';
import { UnencodableCharacterError } from '../utils/windows1252.js';
import { backupFile, fileTimestamp, renameWithRetry, writeFileAtomic } from './fileWriter.js';
import { SongEditError } from './songEditService.js';

/** Écart toléré sur la date de modification (arrondis du système de fichiers), en ms. */
const MTIME_TOLERANCE_MS = 1;
/** Sous-dossier des journaux de renommage, dans le dossier de sauvegardes. */
const JOURNAL_DIR = 'renames';
const JOURNAL_ID = /^[0-9TZ-]+-[0-9a-f]{8}$/;

/**
 * @typedef {object} RenameRequest
 * @property {{ folder?: string, files?: Record<string, string> }} [overrides]  Noms saisis.
 * @property {RenameExpected} [expected]  État vu lors de la simulation (obligatoire pour appliquer).
 *
 * @typedef {object} RenameExpected
 * @property {string} listing  Empreinte de la liste des fichiers du dossier.
 * @property {Record<string, number>} txts  Date de modification de chaque .txt.
 *
 * @typedef {object} RenameJournal Opération faite, pour l'annuler.
 * @property {string} id
 * @property {string} date
 * @property {string} parent       Dossier parent, relatif à SONG_DIR (« / »).
 * @property {string} folderBefore
 * @property {string} folderAfter
 * @property {{ from: string, to: string }[]} files
 * @property {{ before: string, after: string, backup: string, modifiedAt: number }[]} txts
 *   .txt réécrits : sauvegarde du contenu d'origine, date après écriture.
 * @property {string | null} undoneAt
 */

/**
 * Empreinte de la liste des fichiers d'un dossier (détecte un ajout, une suppression ou un
 * renommage fait ailleurs entre la simulation et l'application).
 * @param {string[]} names
 */
function listingKey(names) {
  const sorted = [...names].sort();
  return createHash('sha1').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string | number>} [params]
 */
const fail = (code, message, status, params) => new SongEditError(code, message, status, params);

/**
 * Le chemin existe-t-il ?
 * @param {string} target
 */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exécute un renommage (ou son annulation) dans un dossier, avec retour arrière en cas d'échec.
 *
 * @param {object} operation
 * @param {string} operation.dir      Dossier actuel (absolu).
 * @param {{ from: string, to: string }[]} operation.files  Fichiers à renommer dans `dir`.
 * @param {{ name: string, data: Uint8Array, original: Uint8Array }[]} operation.writes
 *   Contenus à écrire, sous le nom final (après renommage).
 * @param {string | null} operation.newDir  Nouveau chemin du dossier (null : inchangé).
 * @param {Pick<Console, 'warn' | 'error'>} logger
 */
async function execute({ dir, files, writes, newDir }, logger) {
  /** @type {(() => Promise<void>)[]} retours arrière, du plus récent au plus ancien */
  const undo = [];
  const token = randomUUID().slice(0, 8);
  try {
    // Deux temps : tous vers un nom temporaire caché, puis vers le nom final.
    const temporaries = files.map(({ from }, index) => ({
      from,
      temporary: `.usm-rename-${token}-${index}${path.extname(from)}`,
    }));
    for (const { from, temporary } of temporaries) {
      await renameWithRetry(path.join(dir, from), path.join(dir, temporary));
      undo.unshift(() => renameWithRetry(path.join(dir, temporary), path.join(dir, from)));
    }
    for (const [index, { to }] of files.entries()) {
      const { temporary } = temporaries[index];
      if (await exists(path.join(dir, to))) {
        throw fail('RENAME_TARGET_EXISTS', `${to} already exists`, 409, { file: to });
      }
      await renameWithRetry(path.join(dir, temporary), path.join(dir, to));
      undo.unshift(() => renameWithRetry(path.join(dir, to), path.join(dir, temporary)));
    }
    for (const { name, data, original } of writes) {
      await writeFileAtomic(path.join(dir, name), data);
      undo.unshift(() => writeFileAtomic(path.join(dir, name), original));
    }
    if (newDir) {
      const caseOnly = fileNameKey(path.basename(dir)) === fileNameKey(path.basename(newDir));
      if (caseOnly) {
        const temporary = path.join(path.dirname(dir), `.usm-rename-${token}`);
        await renameWithRetry(dir, temporary);
        undo.unshift(() => renameWithRetry(temporary, dir));
        await renameWithRetry(temporary, newDir);
      } else {
        if (await exists(newDir)) {
          throw fail('RENAME_TARGET_EXISTS', `${path.basename(newDir)} already exists`, 409, {
            file: path.basename(newDir),
          });
        }
        await renameWithRetry(dir, newDir);
      }
    }
  } catch (error) {
    for (const step of undo) {
      try {
        await step();
      } catch (undoError) {
        logger.error(`Rename rollback incomplete in ${dir}: ${undoError}`);
      }
    }
    throw error;
  }
}

/**
 * @param {object} options
 * @param {import('./catalogService.js').Catalog} options.catalog
 * @param {string | null} options.songDir
 * @param {string} options.backupDir
 * @param {() => import('../parsers/naming.js').NamingRules} options.getNaming
 * @param {Pick<Console, 'info' | 'warn' | 'error'>} [options.logger]
 */
export function createRenamer({ catalog, songDir, backupDir, getNaming, logger = console }) {
  /**
   * Lit le dossier d'une chanson et calcule le plan.
   * @param {string} id
   * @param {RenameRequest['overrides']} overrides
   */
  async function load(id, overrides) {
    const song = catalog.getSong(id);
    const dir = song ? catalog.resolveSongFolder(song) : null;
    if (!song || !dir || !songDir) throw fail('SONG_NOT_FOUND', 'Song not found', 404);
    const fileNames = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const txtNames = fileNames.filter(
      (name) => !name.startsWith('.') && path.extname(name).toLowerCase() === '.txt',
    );
    const txts = [];
    /** @type {Record<string, { buffer: Buffer, encoding: string, modifiedAt: number }>} */
    const sources = {};
    for (const txtFile of txtNames) {
      const file = path.join(dir, txtFile);
      const [buffer, info] = await Promise.all([readFile(file), stat(file)]);
      const parsed = parseUltrastarTxt(buffer);
      if (!parsed.headers.TITLE && !parsed.headers.ARTIST) continue; // pas une chanson
      const { text, encoding } = decodeSongBuffer(buffer);
      txts.push({ txtFile, text, headers: parsed.headers, isDuet: parsed.stats.isDuet });
      sources[txtFile] = { buffer, encoding, modifiedAt: info.mtimeMs };
    }
    const folderName = song.folder.includes('/')
      ? song.folder.slice(song.folder.lastIndexOf('/') + 1)
      : song.folder;
    const plan = buildRenamePlan({ folderName, fileNames, txts, rules: getNaming(), overrides });

    // Dossier : un autre dossier du même nom ne doit pas exister à côté.
    const parentDir = path.dirname(dir);
    if (plan.folder?.action === 'rename' && !plan.folder.error) {
      const target = resolveInside(
        songDir,
        path.join(path.relative(songDir, parentDir), plan.folder.to),
      );
      const caseOnly = fileNameKey(plan.folder.to) === fileNameKey(plan.folder.from);
      if (!target) plan.folder.error = 'FORBIDDEN_CHARACTER';
      else if (!caseOnly && (await exists(target))) plan.folder.error = 'EXISTS';
      if (plan.folder.error) plan.errorCount += 1;
    }
    // Le nouveau nom doit pouvoir s'écrire dans l'encodage du .txt (Windows-1252…).
    /** @type {Record<string, Buffer>} */
    const encoded = {};
    /** @type {{ txtFile: string, character: string, encoding: string }[]} */
    const unencodable = [];
    for (const result of plan.txts) {
      if (result.changes.length === 0) continue;
      const { encoding } = sources[result.txtFile];
      try {
        encoded[result.txtFile] = encodeSongText(
          result.text,
          /** @type {Parameters<typeof encodeSongText>[1]} */ (encoding),
        );
      } catch (error) {
        if (!(error instanceof UnencodableCharacterError)) throw error;
        unencodable.push({ txtFile: result.txtFile, character: error.character, encoding });
      }
    }
    const expected = {
      listing: listingKey(fileNames),
      txts: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.modifiedAt])),
    };
    return { song, dir, parentDir, plan, sources, encoded, unencodable, expected, folderName };
  }

  /**
   * Plan tel que l'envoie l'API (sans le contenu des fichiers).
   * @param {Awaited<ReturnType<typeof load>>} loaded
   */
  function publicPlan({ song, plan, unencodable, expected }) {
    return {
      songFolder: song.folder,
      artist: plan.artist,
      title: plan.title,
      folder: plan.folder,
      files: plan.files,
      txts: plan.txts.map(({ txtFile, newTxtFile, changes }) => ({
        txtFile,
        newTxtFile,
        changes,
      })),
      unencodable,
      renameCount: plan.renameCount,
      errorCount: plan.errorCount + unencodable.length,
      expected,
    };
  }

  /** @param {string} id */
  function journalFile(id) {
    if (!JOURNAL_ID.test(id)) return null;
    return resolveInside(backupDir, path.join(JOURNAL_DIR, `${id}.json`));
  }

  return {
    /**
     * Simulation : plan de renommage du dossier de la chanson, avec les noms saisis.
     * @param {string} id
     * @param {RenameRequest} [request]
     */
    async preview(id, { overrides } = {}) {
      return publicPlan(await load(id, overrides));
    },

    /**
     * Applique le renommage.
     * @param {string} id
     * @param {RenameRequest} request
     * @returns {Promise<{ songId: string | null, journal: string | null, renamed: number,
     *   backups: string[] }>}
     */
    async apply(id, { overrides, expected }) {
      const loaded = await load(id, overrides);
      const { song, dir, parentDir, plan, sources, encoded, unencodable } = loaded;
      if (
        !expected ||
        expected.listing !== loaded.expected.listing ||
        Object.keys(sources).some(
          (name) =>
            Math.abs((expected.txts?.[name] ?? -1) - sources[name].modifiedAt) > MTIME_TOLERANCE_MS,
        )
      ) {
        throw fail('FOLDER_CHANGED', 'The folder changed since the simulation', 409);
      }
      if (plan.errorCount > 0 || unencodable.length > 0) {
        throw fail('RENAME_CONFLICT', 'Some names are invalid', 400);
      }
      if (plan.renameCount === 0 && Object.keys(encoded).length === 0) {
        return { songId: id, journal: null, renamed: 0, backups: [] };
      }

      const relativeParent = path.relative(
        path.resolve(/** @type {string} */ (songDir)),
        parentDir,
      );
      const folderAfter =
        plan.folder?.action === 'rename' ? plan.folder.to : (plan.folder?.from ?? '');
      const renames = plan.files
        .filter((e) => e.action === 'rename')
        .map(({ from, to }) => ({ from, to }));

      // Sauvegarde des .txt dont le contenu change, avant toute opération.
      /** @type {RenameJournal['txts']} */
      const journalTxts = [];
      const writes = [];
      for (const result of plan.txts) {
        const data = encoded[result.txtFile];
        if (!data) continue;
        const backup = await backupFile({
          file: path.join(dir, result.txtFile),
          relativePath: path.join(song.folder, result.txtFile),
          backupDir,
        });
        writes.push({ name: result.newTxtFile, data, original: sources[result.txtFile].buffer });
        journalTxts.push({
          before: result.txtFile,
          after: result.newTxtFile,
          backup,
          modifiedAt: 0,
        });
      }

      const newDir = plan.folder?.action === 'rename' ? path.join(parentDir, plan.folder.to) : null;
      await execute({ dir, files: renames, writes, newDir }, logger);

      // Dates des .txt réécrits : l'annulation vérifiera qu'ils n'ont pas changé depuis.
      const finalDir = newDir ?? dir;
      for (const entry of journalTxts) {
        entry.modifiedAt = (await stat(path.join(finalDir, entry.after))).mtimeMs;
      }
      const date = new Date();
      /** @type {RenameJournal} */
      const journal = {
        id: `${fileTimestamp(date)}-${randomUUID().slice(0, 8)}`,
        date: date.toISOString(),
        parent: relativeParent.split(path.sep).join('/'),
        folderBefore: plan.folder?.from ?? '',
        folderAfter,
        files: renames,
        txts: journalTxts,
        undoneAt: null,
      };
      const file = /** @type {string} */ (journalFile(journal.id));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(journal, null, 2));
      logger.info(
        `Renamed ${song.folder} → ${folderAfter || '(root)'}: ${renames.length} file(s), ` +
          `${writes.length} .txt updated (journal: ${journal.id})`,
      );

      // Catalogue : chansons du dossier relues (les identifiants changent avec le chemin).
      const newFolder = [journal.parent, folderAfter].filter(Boolean).join('/');
      const fresh = await catalog.replaceFolder(song.folder, newFolder);
      const txtAfter =
        plan.files.find((e) => fileNameKey(e.from) === fileNameKey(song.txtFile))?.to ??
        song.txtFile;
      const same = fresh.find((s) => fileNameKey(s.txtFile) === fileNameKey(txtAfter));
      return {
        songId: same?.id ?? null,
        journal: journal.id,
        renamed: plan.renameCount,
        backups: journalTxts.map((t) => t.backup),
      };
    },

    /**
     * Annule un renommage (journal), si rien n'a changé depuis.
     * @param {string} journalId
     * @returns {Promise<{ songIds: string[] }>}
     */
    async undo(journalId) {
      const file = journalFile(journalId);
      if (!file || !songDir || !(await exists(file))) {
        throw fail('RENAME_NOT_FOUND', 'Rename not found', 404);
      }
      /** @type {RenameJournal} */
      const journal = JSON.parse(await readFile(file, 'utf8'));
      if (journal.undoneAt) throw fail('RENAME_ALREADY_UNDONE', 'Already undone', 409);
      const parentDir = resolveInside(songDir, journal.parent);
      const dir = parentDir ? resolveInside(parentDir, journal.folderAfter) : null;
      const oldDir = parentDir ? resolveInside(parentDir, journal.folderBefore) : null;
      if (!dir || !oldDir || !(await exists(dir))) {
        throw fail('FOLDER_CHANGED', 'The folder changed since the rename', 409);
      }
      // Rien ne doit avoir bougé depuis : fichiers renommés présents, .txt non modifiés.
      for (const { to } of journal.files) {
        if (!(await exists(path.join(dir, to)))) {
          throw fail('FOLDER_CHANGED', `${to} is missing`, 409);
        }
      }
      for (const txt of journal.txts) {
        const info = await stat(path.join(dir, txt.after)).catch(() => null);
        if (!info || Math.abs(info.mtimeMs - txt.modifiedAt) > MTIME_TOLERANCE_MS) {
          throw fail('FOLDER_CHANGED', `${txt.after} changed since the rename`, 409);
        }
      }

      const relativeFolder = [journal.parent, journal.folderAfter].filter(Boolean).join('/');
      const writes = [];
      for (const txt of journal.txts) {
        const backupPath = resolveInside(backupDir, txt.backup);
        if (!backupPath) throw fail('RENAME_NOT_FOUND', 'Backup not found', 404);
        const current = await readFile(path.join(dir, txt.after));
        // Le contenu actuel est sauvegardé lui aussi, comme pour toute écriture.
        await backupFile({
          file: path.join(dir, txt.after),
          relativePath: path.join(relativeFolder, txt.after),
          backupDir,
        });
        writes.push({ name: txt.before, data: await readFile(backupPath), original: current });
      }
      const newDir = journal.folderBefore !== journal.folderAfter ? oldDir : null;
      await execute(
        {
          dir,
          files: journal.files.map(({ from, to }) => ({ from: to, to: from })),
          writes,
          newDir,
        },
        logger,
      );
      journal.undoneAt = new Date().toISOString();
      await writeFile(file, JSON.stringify(journal, null, 2));
      logger.info(`Rename ${journal.id} undone: back to ${journal.folderBefore}`);

      const oldFolder = [journal.parent, journal.folderBefore].filter(Boolean).join('/');
      const fresh = await catalog.replaceFolder(relativeFolder, oldFolder);
      return { songIds: fresh.map((s) => s.id) };
    },
  };
}

/** @typedef {ReturnType<typeof createRenamer>} Renamer */
