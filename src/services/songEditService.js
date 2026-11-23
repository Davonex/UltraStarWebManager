// @ts-check
/**
 * Modification des en-têtes d'une chanson (EDITION, TAGS, CREATOR, YEAR, GENRE, LANGUAGE).
 *
 * Contient aussi la conversion d'encodage en UTF-8 sans BOM (format 1.1.0).
 *
 * Étapes : vérifie que le fichier n'a pas changé depuis son affichage → calcule les
 * changements → (simulation : s'arrête là) → ré-encode dans l'encodage d'origine →
 * sauvegarde datée → écriture atomique → met à jour le catalogue.
 *
 * @module services/songEditService
 */
import { readFile, stat } from 'node:fs/promises';
import { encodeSongText, updateHeaders } from '../parsers/ultrastarEdit.js';
import { decodeSongBuffer } from '../parsers/ultrastarTxt.js';
import { UnencodableCharacterError } from '../utils/windows1252.js';
import { backupFile, writeFileAtomic } from './fileWriter.js';

/** En-têtes modifiables depuis l'interface (YEAR, GENRE, LANGUAGE : via MusicBrainz). */
export const EDITABLE_HEADERS = Object.freeze([
  'EDITION',
  'TAGS',
  'CREATOR',
  'YEAR',
  'GENRE',
  'LANGUAGE',
]);
/** Longueur maximale d'une valeur d'en-tête. */
export const MAX_VALUE_LENGTH = 500;
/** Écart toléré sur la date de modification (arrondis du système de fichiers), en ms. */
const MTIME_TOLERANCE_MS = 1;
// biome-ignore lint/suspicious/noControlCharactersInRegex: on cherche justement les caractères de contrôle
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Erreur métier, avec un code traduisible et un statut HTTP. */
export class SongEditError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {Record<string, string | number>} [params]
   */
  constructor(code, message, status, params) {
    super(message);
    this.name = 'SongEditError';
    this.code = code;
    this.status = status;
    this.params = params;
  }
}

/**
 * Nettoie une valeur à plusieurs éléments séparés par des virgules : espaces retirés,
 * éléments vides et doublons (sans tenir compte de la casse) supprimés.
 * Renvoie null si la liste est vide (l'en-tête sera supprimé).
 *
 * @param {string} header
 * @param {unknown} value
 * @returns {string | null}
 * @throws {SongEditError}
 */
export function normalizeHeaderValue(header, value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new SongEditError('INVALID_VALUE', `${header} must be a string`, 400, { header });
  }
  if (value.length > MAX_VALUE_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new SongEditError('INVALID_VALUE', `Invalid value for ${header}`, 400, { header });
  }
  if (header === 'YEAR') {
    // Une seule valeur : une année sur 4 chiffres (vide = supprimer l'en-tête).
    const year = value.trim();
    if (year === '') return null;
    if (!/^\d{4}$/.test(year)) {
      throw new SongEditError('INVALID_VALUE', 'YEAR must be a 4-digit year', 400, { header });
    }
    return year;
  }
  const seen = new Set();
  const items = [];
  for (const item of value.split(',')) {
    const clean = item.trim().replace(/\s+/g, ' ');
    const key = clean.toLocaleLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      items.push(clean);
    }
  }
  return items.length > 0 ? items.join(', ') : null;
}

/**
 * @param {object} options
 * @param {import('./catalogService.js').Catalog} options.catalog
 * @param {string} options.backupDir
 * @param {Pick<Console, 'info'>} [options.logger]
 */
export function createSongEditor({ catalog, backupDir, logger = console }) {
  /**
   * Chanson, fichier et contenu actuels, après vérification de la date de modification.
   * @param {string} id
   * @param {number} expectedModifiedAt
   */
  async function loadForWrite(id, expectedModifiedAt) {
    const song = catalog.getSong(id);
    const file = song ? catalog.resolveSongFile(song) : null;
    if (!song || !file) throw new SongEditError('SONG_NOT_FOUND', 'Song not found', 404);
    const [buffer, info] = await Promise.all([readFile(file), stat(file)]);
    if (Math.abs(info.mtimeMs - expectedModifiedAt) > MTIME_TOLERANCE_MS) {
      throw new SongEditError(
        'SONG_CHANGED',
        'The song file changed since it was displayed: refresh and try again',
        409,
      );
    }
    return { song, file, buffer };
  }

  /**
   * Sauvegarde, écrit, journalise et met le catalogue à jour.
   * @param {import('./catalogService.js').Song} song
   * @param {string} file
   * @param {Uint8Array} data
   * @param {string} what  Description pour le journal.
   */
  async function commit(song, file, data, what) {
    const relativePath = `${song.folder}/${song.txtFile}`;
    const backup = await backupFile({ file, relativePath, backupDir });
    await writeFileAtomic(file, data);
    logger.info(`Edited ${relativePath}: ${what} (backup: ${backup})`);
    const refreshed = (await catalog.refreshSong(song.id)) ?? song;
    return { song: refreshed, backup };
  }

  return {
    /**
     * Convertit le fichier d'une chanson en UTF-8 sans BOM (encodage exigé par le format 1.1.0).
     * Le texte et les fins de ligne restent identiques ; seul l'encodage change.
     *
     * @param {string} id
     * @param {{ expectedModifiedAt: number, dryRun?: boolean }} request
     * @returns {Promise<{ changed: boolean, from: string, song: import('./catalogService.js').Song,
     *   backup: string | null }>}
     * @throws {SongEditError}
     */
    async convertToUtf8(id, { expectedModifiedAt, dryRun = false }) {
      const { song, file, buffer } = await loadForWrite(id, expectedModifiedAt);
      const { text, encoding } = decodeSongBuffer(buffer);
      if (encoding === 'utf-8' || dryRun) {
        return { changed: encoding !== 'utf-8', from: encoding, song, backup: null };
      }
      const data = encodeSongText(text, 'utf-8');
      // Contrôle : relu, le nouveau fichier doit redonner exactement le même texte.
      const check = decodeSongBuffer(data);
      if (check.encoding !== 'utf-8' || check.text !== text) {
        throw new SongEditError(
          'CONVERSION_FAILED',
          'Conversion check failed: nothing written',
          500,
        );
      }
      const result = await commit(song, file, data, `encoding ${encoding} → utf-8`);
      return { changed: true, from: encoding, ...result };
    },

    /**
     * Remplace le fichier vidéo référencé (#VIDEO), après une conversion vidéo.
     * Usage interne : cet en-tête n'est pas modifiable directement depuis l'interface.
     *
     * @param {string} id
     * @param {{ video: string, expectedModifiedAt: number }} request
     * @returns {Promise<{ song: import('./catalogService.js').Song, backup: string | null }>}
     * @throws {SongEditError}
     */
    async setVideoFile(id, { video, expectedModifiedAt }) {
      const { song, file, buffer } = await loadForWrite(id, expectedModifiedAt);
      const { text, encoding } = decodeSongBuffer(buffer);
      const { text: updated, changes } = updateHeaders(text, { VIDEO: video });
      if (changes.length === 0) return { song, backup: null };
      // Le nom vient du fichier d'origine : il est encodable dans l'encodage du .txt.
      return commit(song, file, encodeSongText(updated, encoding), `VIDEO → ${video}`);
    },

    /**
     * Remplace le fichier audio référencé, après l'extraction du MP3 d'une vidéo.
     * Met à jour #AUDIO et/ou #MP3, selon ceux présents dans le fichier (format 1.1.0 :
     * #AUDIO ; anciens fichiers : #MP3). Usage interne, comme setVideoFile.
     *
     * @param {string} id
     * @param {{ audio: string, expectedModifiedAt: number }} request
     * @returns {Promise<{ song: import('./catalogService.js').Song, backup: string | null,
     *   headers: string[] }>}
     * @throws {SongEditError}
     */
    async setAudioFile(id, { audio, expectedModifiedAt }) {
      const { song, file, buffer } = await loadForWrite(id, expectedModifiedAt);
      const { text, encoding } = decodeSongBuffer(buffer);
      const present = ['AUDIO', 'MP3'].filter((header) =>
        new RegExp(`^#${header}:`, 'im').test(text),
      );
      const headers = present.length > 0 ? present : ['MP3'];
      /** @type {Record<string, string>} */
      const values = Object.fromEntries(headers.map((header) => [header, audio]));
      const { text: updated, changes } = updateHeaders(text, values);
      if (changes.length === 0) return { song, backup: null, headers };
      const result = await commit(
        song,
        file,
        encodeSongText(updated, encoding),
        `${headers.join(', ')} → ${audio}`,
      );
      return { ...result, headers };
    },

    /**
     * Modifie des en-têtes d'une chanson.
     *
     * @param {string} id
     * @param {object} request
     * @param {Record<string, unknown>} request.values  Nouvelles valeurs (null = supprimer).
     * @param {number} request.expectedModifiedAt  Date de modification vue par l'utilisateur.
     * @param {boolean} [request.dryRun]  Simulation : calcule les changements sans écrire.
     * @returns {Promise<{ changes: import('../parsers/ultrastarEdit.js').HeaderChange[],
     *   song: import('./catalogService.js').Song, backup: string | null }>}
     * @throws {SongEditError}
     */
    async editHeaders(id, { values, expectedModifiedAt, dryRun = false }) {
      /** @type {Record<string, string | null>} */
      const clean = {};
      for (const [header, value] of Object.entries(values)) {
        if (!EDITABLE_HEADERS.includes(header)) {
          throw new SongEditError('HEADER_NOT_EDITABLE', `${header} cannot be edited`, 400, {
            header,
          });
        }
        clean[header] = normalizeHeaderValue(header, value);
      }

      const { song, file, buffer } = await loadForWrite(id, expectedModifiedAt);
      const { text, encoding } = decodeSongBuffer(buffer);
      const { text: updated, changes } = updateHeaders(text, clean);
      if (dryRun || changes.length === 0) return { changes, song, backup: null };

      let data;
      try {
        data = encodeSongText(updated, encoding);
      } catch (error) {
        if (!(error instanceof UnencodableCharacterError)) throw error;
        throw new SongEditError(
          'UNENCODABLE_CHARACTER',
          `"${error.character}" cannot be saved in this ${encoding} file`,
          422,
          { character: error.character, encoding },
        );
      }

      const result = await commit(song, file, data, changes.map((c) => c.header).join(', '));
      return { changes, ...result };
    },
  };
}

/** @typedef {ReturnType<typeof createSongEditor>} SongEditor */
