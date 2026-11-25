// @ts-check
/**
 * Playlists UltraStar (.upl) du dossier PLAYLIST_DIR, reliées aux chansons du catalogue.
 * Écriture (ajout / retrait d'une chanson) : sauvegarde datée dans BACKUP_DIR/_playlists, puis
 * écriture atomique ; encodage et fins de ligne conservés ; refus si le fichier a changé.
 *
 * Une ligne « Artiste : Titre » correspond à une chanson si l'artiste et le titre sont
 * identiques, sans tenir compte de la casse, des accents ni des espaces superflus.
 *
 * @module services/playlistService
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { encodeSongText } from '../parsers/ultrastarEdit.js';
import {
  addPlaylistEntry,
  parseUltrastarPlaylist,
  removePlaylistEntry,
  renamePlaylistEntry,
} from '../parsers/ultrastarPlaylist.js';
import { decodeSongBuffer } from '../parsers/ultrastarTxt.js';
import { resolveInside } from '../utils/safePath.js';
import { looseKey } from '../utils/text.js';
import { UnencodableCharacterError } from '../utils/windows1252.js';
import { backupFile, writeFileAtomic } from './fileWriter.js';
import { SongEditError } from './songEditService.js';

const PLAYLIST_EXTENSION = '.upl';

/**
 * @typedef {object} Playlist
 * @property {string} name      Nom affiché (#Name, sinon nom du fichier sans extension).
 * @property {string} file      Nom du fichier .upl.
 * @property {number} modifiedAt  Date de modification du fichier (contrôle avant écriture).
 * @property {string[]} songIds Chansons trouvées dans le catalogue, dans l'ordre de la playlist.
 * @property {import('../parsers/ultrastarPlaylist.js').PlaylistEntry[]} missing
 *   Lignes sans chanson correspondante dans la bibliothèque.
 */

/**
 * Clé de rapprochement d'une chanson : artiste + titre, comparaison souple.
 * @param {string | null} artist
 * @param {string | null} title
 * @returns {string}
 */
export function songMatchKey(artist, title) {
  return `${looseKey(artist ?? '')}\u0000${looseKey(title ?? '')}`;
}

/**
 * Index « artiste + titre » → identifiants (plusieurs versions possibles d'une chanson).
 * @param {readonly import('./catalogService.js').Song[]} songs
 * @returns {Map<string, string[]>}
 */
export function indexSongs(songs) {
  /** @type {Map<string, string[]>} */
  const index = new Map();
  for (const song of songs) {
    const key = songMatchKey(song.artist, song.title);
    index.set(key, [...(index.get(key) ?? []), song.id]);
  }
  return index;
}

/**
 * Relie les lignes d'une playlist aux chansons (fonction pure).
 * @param {import('../parsers/ultrastarPlaylist.js').PlaylistEntry[]} entries
 * @param {Map<string, string[]>} index
 * @returns {Pick<Playlist, 'songIds' | 'missing'>}
 */
export function matchEntries(entries, index) {
  /** @type {Set<string>} */
  const songIds = new Set();
  /** @type {Playlist['missing']} */
  const missing = [];
  for (const entry of entries) {
    const ids = index.get(songMatchKey(entry.artist, entry.title));
    if (!ids) missing.push(entry);
    else for (const id of ids) songIds.add(id);
  }
  return { songIds: [...songIds], missing };
}

/**
 * @param {object} options
 * @param {string | null} options.playlistDir  Dossier des .upl (null = non configuré).
 * @param {import('./catalogService.js').Catalog} options.catalog
 * @param {string | null} [options.backupDir]  Sauvegardes avant écriture (null = écriture refusée).
 * @param {Pick<Console, 'warn' | 'info'>} [options.logger]
 */
export function createPlaylists({ playlistDir, catalog, backupDir = null, logger = console }) {
  /**
   * Noms des fichiers .upl du dossier (vide si absent ou illisible).
   * @returns {Promise<string[]>}
   */
  async function listFiles() {
    if (!playlistDir) return [];
    try {
      const entries = await readdir(playlistDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === PLAYLIST_EXTENSION)
        .map((e) => e.name);
    } catch (error) {
      logger.warn(`Playlist folder unreadable: ${/** @type {Error} */ (error).message}`);
      return [];
    }
  }

  /** Sous-dossier des sauvegardes de playlists (séparé des dossiers de chansons). */
  const BACKUP_FOLDER = '_playlists';

  /**
   * Chemin absolu d'une playlist désignée par le navigateur : un simple nom de fichier .upl,
   * à l'intérieur de PLAYLIST_DIR (sinon null).
   * @param {string} file
   * @returns {string | null}
   */
  function resolvePlaylist(file) {
    if (!playlistDir || typeof file !== 'string' || path.basename(file) !== file) return null;
    if (path.extname(file).toLowerCase() !== PLAYLIST_EXTENSION) return null;
    return resolveInside(playlistDir, file);
  }

  /**
   * Ajoute ou retire une chanson dans une playlist.
   * @param {'add' | 'remove'} action
   * @param {string} file
   * @param {string} songId
   * @param {number} expectedModifiedAt
   * @returns {Promise<{ changed: boolean, backup: string | null }>}
   * @throws {SongEditError}
   */
  async function changeSong(action, file, songId, expectedModifiedAt) {
    const fullPath = resolvePlaylist(file);
    if (!fullPath) throw new SongEditError('PLAYLIST_NOT_FOUND', 'Playlist not found', 404);
    const song = catalog.getSong(songId);
    if (!song?.artist || !song.title) {
      throw new SongEditError('SONG_NOT_FOUND', 'Song not found (artist and title needed)', 404);
    }
    if (!backupDir) throw new SongEditError('PLAYLIST_READ_ONLY', 'No backup folder', 500);
    /** @type {Buffer} */
    let buffer;
    /** @type {number} */
    let mtimeMs;
    try {
      [buffer, { mtimeMs }] = await Promise.all([readFile(fullPath), stat(fullPath)]);
    } catch {
      throw new SongEditError('PLAYLIST_NOT_FOUND', 'Playlist not found', 404);
    }
    if (Math.abs(mtimeMs - expectedModifiedAt) > 1) {
      throw new SongEditError(
        'PLAYLIST_CHANGED',
        'The playlist changed since it was displayed',
        409,
      );
    }

    const { text, encoding } = decodeSongBuffer(buffer);
    const entry = { artist: song.artist, title: song.title };
    /** @param {{ artist: string, title: string }} a @param {{ artist: string, title: string }} b */
    const same = (a, b) => songMatchKey(a.artist, a.title) === songMatchKey(b.artist, b.title);
    const result =
      action === 'add'
        ? addPlaylistEntry(text, entry, same)
        : removePlaylistEntry(text, entry, same);
    const changed = 'changed' in result ? result.changed : result.removed > 0;
    if (!changed) return { changed: false, backup: null };

    let data;
    try {
      data = encodeSongText(result.text, encoding);
    } catch (error) {
      if (!(error instanceof UnencodableCharacterError)) throw error;
      throw new SongEditError(
        'UNENCODABLE_CHARACTER',
        `"${error.character}" cannot be saved in this ${encoding} file`,
        422,
        { character: error.character, encoding },
      );
    }
    const backup = await backupFile({
      file: fullPath,
      relativePath: `${BACKUP_FOLDER}/${file}`,
      backupDir,
    });
    await writeFileAtomic(fullPath, data);
    logger.info(
      `Playlist ${file}: ${action} "${entry.artist} : ${entry.title}" (backup: ${backup})`,
    );
    return { changed: true, backup };
  }

  /**
   * Lit une playlist ; null si le fichier est illisible (journalisé, ignoré).
   * @param {string} file
   * @returns {Promise<(import('../parsers/ultrastarPlaylist.js').ParsedPlaylist & { modifiedAt: number }) | null>}
   */
  async function readPlaylist(file) {
    try {
      const fullPath = path.join(/** @type {string} */ (playlistDir), file);
      const [buffer, info] = await Promise.all([readFile(fullPath), stat(fullPath)]);
      return { ...parseUltrastarPlaylist(decodeSongBuffer(buffer).text), modifiedAt: info.mtimeMs };
    } catch (error) {
      logger.warn(`Playlist skipped (${file}): ${/** @type {Error} */ (error).message}`);
      return null;
    }
  }

  return {
    /** @returns {boolean} true si PLAYLIST_DIR est configuré. */
    isConfigured() {
      return playlistDir !== null;
    },

    /**
     * Toutes les playlists, relues à chaque appel (le dossier change hors de l'application),
     * triées par nom. Deux playlists de même nom sont distinguées par leur fichier.
     * @returns {Promise<Playlist[]>}
     */
    async list() {
      const index = indexSongs(catalog.getSongs());
      const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
      const files = (await listFiles()).sort(collator.compare);
      /** @type {Playlist[]} */
      const playlists = [];
      /** @type {Set<string>} */
      const usedNames = new Set();
      for (const file of files) {
        const parsed = await readPlaylist(file);
        if (!parsed) continue;
        const baseName = parsed.name ?? path.basename(file, path.extname(file));
        const name = usedNames.has(looseKey(baseName)) ? `${baseName} (${file})` : baseName;
        usedNames.add(looseKey(name));
        playlists.push({
          name,
          file,
          modifiedAt: parsed.modifiedAt,
          ...matchEntries(parsed.entries, index),
        });
      }
      return playlists.sort((a, b) => collator.compare(a.name, b.name));
    },

    /**
     * Ajoute la chanson à la fin de la playlist (rien si elle y est déjà).
     * @param {string} file  Nom du fichier .upl.
     * @param {string} songId
     * @param {number} expectedModifiedAt  Date du .upl vue par l'utilisateur.
     */
    addSong: (file, songId, expectedModifiedAt) =>
      changeSong('add', file, songId, expectedModifiedAt),

    /**
     * Retire la chanson de la playlist (toutes ses lignes).
     * @param {string} file
     * @param {string} songId
     * @param {number} expectedModifiedAt
     */
    removeSong: (file, songId, expectedModifiedAt) =>
      changeSong('remove', file, songId, expectedModifiedAt),

    /**
     * Met à jour le nom des chansons dans toutes les playlists, après la modification de
     * l'artiste ou du titre (« Ancien artiste : Ancien titre » → nouveau nom). Chaque playlist
     * modifiée est sauvegardée avant ; une playlist impossible à écrire est signalée.
     *
     * @param {{ from: { artist: string, title: string }, to: { artist: string, title: string } }[]} renames
     * @returns {Promise<{ updated: { file: string, backup: string }[], failed: { file: string, code: string }[] }>}
     */
    async renameSongEntries(renames) {
      /** @type {{ file: string, backup: string }[]} */
      const updated = [];
      /** @type {{ file: string, code: string }[]} */
      const failed = [];
      if (!backupDir || renames.length === 0) return { updated, failed };
      /** @param {{ artist: string, title: string }} a @param {{ artist: string, title: string }} b */
      const same = (a, b) => songMatchKey(a.artist, a.title) === songMatchKey(b.artist, b.title);
      for (const file of await listFiles()) {
        const fullPath = path.join(/** @type {string} */ (playlistDir), file);
        try {
          const { text, encoding } = decodeSongBuffer(await readFile(fullPath));
          let next = text;
          let replaced = 0;
          for (const { from, to } of renames) {
            const result = renamePlaylistEntry(next, from, to, same);
            next = result.text;
            replaced += result.replaced;
          }
          if (replaced === 0) continue;
          const data = encodeSongText(next, encoding);
          const backup = await backupFile({
            file: fullPath,
            relativePath: `${BACKUP_FOLDER}/${file}`,
            backupDir,
          });
          await writeFileAtomic(fullPath, data);
          logger.info(`Playlist ${file}: ${replaced} song name(s) updated (backup: ${backup})`);
          updated.push({ file, backup });
        } catch (error) {
          const code =
            error instanceof UnencodableCharacterError
              ? 'UNENCODABLE_CHARACTER'
              : 'PLAYLIST_WRITE_FAILED';
          logger.warn(`Playlist ${file} not updated: ${/** @type {Error} */ (error).message}`);
          failed.push({ file, code });
        }
      }
      return { updated, failed };
    },

    /**
     * Une playlist relue après modification (null si introuvable).
     * @param {string} file
     * @returns {Promise<Playlist | null>}
     */
    async get(file) {
      return (await this.list()).find((p) => p.file === file) ?? null;
    },
  };
}

/** @typedef {ReturnType<typeof createPlaylists>} Playlists */
