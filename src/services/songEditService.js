// @ts-check
/**
 * Modification des en-têtes d'une chanson (ARTIST, TITLE, EDITION, TAGS, CREATOR, YEAR, GENRE,
 * LANGUAGE, P1, P2) et de la synchronisation (BPM, GAP, VIDEOGAP, PREVIEWSTART, medley,
 * START, END).
 *
 * Artiste et titre : la modification s'applique aussi aux autres .txt du dossier qui
 * désignent la même chanson (solo, duo… ; la marque de duo du titre est gardée) et aux
 * playlists qui la citent (« Artiste : Titre »).
 *
 * Contient aussi la conversion d'encodage en UTF-8 sans BOM (format 1.1.0) et la réparation
 * des caractères mal encodés (« Ã© » au lieu de « é »).
 *
 * Étapes : vérifie que le fichier n'a pas changé depuis son affichage → calcule les
 * changements → (simulation : s'arrête là) → ré-encode dans l'encodage d'origine →
 * sauvegarde datée → écriture atomique → met à jour le catalogue.
 *
 * @module services/songEditService
 */
import { readFile, stat } from 'node:fs/promises';
import { planMojibakeRepair } from '../parsers/mojibake.js';
import { duetMarkOf, titleWithoutDuetMark } from '../parsers/naming.js';
import { encodeSongText, updateHeaders } from '../parsers/ultrastarEdit.js';
import { decodeSongBuffer } from '../parsers/ultrastarTxt.js';
import { looseKey } from '../utils/text.js';
import { UnencodableCharacterError } from '../utils/windows1252.js';
import { backupFile, writeFileAtomic } from './fileWriter.js';

/** En-têtes modifiables depuis l'interface (fenêtre info, MusicBrainz). */
export const EDITABLE_HEADERS = Object.freeze([
  'ARTIST',
  'TITLE',
  'EDITION',
  'TAGS',
  'CREATOR',
  'YEAR',
  'GENRE',
  'LANGUAGE',
  'P1',
  'P2',
  'BPM',
  'GAP',
  'VIDEOGAP',
  'PREVIEWSTART',
  'MEDLEYSTARTBEAT',
  'MEDLEYENDBEAT',
  'START',
  'END',
]);

/**
 * Synchronisation : valeurs numériques. `decimal` : virgule ou point accepté (le séparateur
 * du fichier est conservé à l'écriture) ; `negative` : valeur négative permise ;
 * `positive` : strictement plus grand que 0.
 */
const TIMING_HEADERS = Object.freeze({
  BPM: { decimal: true, negative: false, positive: true }, // BPM UltraStar
  GAP: { decimal: true, negative: false, positive: false }, // millisecondes
  VIDEOGAP: { decimal: true, negative: true, positive: false }, // secondes
  PREVIEWSTART: { decimal: true, negative: false, positive: false }, // secondes
  MEDLEYSTARTBEAT: { decimal: false, negative: false, positive: false }, // beat
  MEDLEYENDBEAT: { decimal: false, negative: false, positive: false }, // beat
  START: { decimal: true, negative: false, positive: false }, // secondes
  END: { decimal: false, negative: false, positive: false }, // millisecondes
});
/** En-têtes à une seule valeur (pas de liste séparée par des virgules). */
const SINGLE_VALUE_HEADERS = new Set(['ARTIST', 'TITLE', 'P1', 'P2']);
/** En-têtes obligatoires : jamais supprimés. */
const REQUIRED_HEADERS = new Set(['ARTIST', 'TITLE', 'BPM']);
/** Ancien nom des chanteurs d'un duo (avant le format 1.0.0), mis à jour s'il est utilisé. */
const LEGACY_SINGER_HEADERS = Object.freeze({ P1: 'DUETSINGERP1', P2: 'DUETSINGERP2' });
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
  if (
    (value === null || (typeof value === 'string' && !value.trim())) &&
    REQUIRED_HEADERS.has(header)
  ) {
    throw new SongEditError('VALUE_REQUIRED', `${header} cannot be empty`, 400, { header });
  }
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new SongEditError('INVALID_VALUE', `${header} must be a string`, 400, { header });
  }
  if (value.length > MAX_VALUE_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new SongEditError('INVALID_VALUE', `Invalid value for ${header}`, 400, { header });
  }
  if (header in TIMING_HEADERS) {
    // Nombre (vide = supprimer l'en-tête) ; séparateur décimal ramené au point ici.
    const rule = TIMING_HEADERS[/** @type {keyof typeof TIMING_HEADERS} */ (header)];
    const number = value.trim().replace(/\s+/g, '');
    if (number === '') return null;
    const pattern = rule.decimal ? /^-?\d+([.,]\d+)?$/ : /^-?\d+$/;
    const parsed = Number(number.replace(',', '.'));
    if (!pattern.test(number) || (!rule.negative && parsed < 0) || (rule.positive && parsed <= 0)) {
      throw new SongEditError('INVALID_NUMBER', `Invalid number for ${header}`, 400, { header });
    }
    return number.replace(',', '.');
  }
  if (SINGLE_VALUE_HEADERS.has(header)) {
    // Nom d'un chanteur : texte simple (il peut contenir des virgules).
    const clean = value.trim().replace(/\s+/g, ' ');
    return clean === '' ? null : clean;
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
 * Valeur brute d'un en-tête dans le texte du .txt (undefined s'il est absent).
 * @param {string} text
 * @param {string} header
 */
function headerValue(text, header) {
  return new RegExp(`^#${header}:(.*)$`, 'im').exec(text)?.[1]?.trim();
}

/**
 * Séparateur décimal du fichier conservé : virgule si l'en-tête modifié l'utilisait déjà,
 * ou, s'il était absent, si un autre nombre du fichier (BPM…) l'utilise.
 * @param {string} text
 * @param {Record<string, string | null>} values  Modifiées sur place.
 */
function applyDecimalSeparator(text, values) {
  const decimals = Object.entries(TIMING_HEADERS)
    .filter(([, rule]) => rule.decimal)
    .map(([header]) => header);
  for (const [header, value] of Object.entries(values)) {
    if (value === null || !decimals.includes(header) || !value.includes('.')) continue;
    const original = headerValue(text, header);
    const comma =
      original !== undefined
        ? original.includes(',')
        : decimals.some((other) => headerValue(text, other)?.includes(','));
    if (comma) values[header] = value.replace('.', ',');
  }
}

/**
 * Le medley doit finir après son début (valeurs modifiées, sinon celles du fichier).
 * @param {string} text
 * @param {Record<string, string | null>} values
 * @throws {SongEditError}
 */
function checkMedley(text, values) {
  if (!('MEDLEYSTARTBEAT' in values) && !('MEDLEYENDBEAT' in values)) return;
  /** @param {string} header */
  const beat = (header) => {
    const value = header in values ? values[header] : headerValue(text, header);
    return value === null || value === undefined || value === '' ? null : Number(value);
  };
  const start = beat('MEDLEYSTARTBEAT');
  const end = beat('MEDLEYENDBEAT');
  if (start !== null && end !== null && end <= start) {
    throw new SongEditError('MEDLEY_ORDER', 'The medley must end after it starts', 400);
  }
}

/**
 * @param {object} options
 * @param {import('./catalogService.js').Catalog} options.catalog
 * @param {string} options.backupDir
 * @param {Pick<import('./playlistService.js').Playlists, 'renameSongEntries'> | null} [options.playlists]
 *   Playlists à mettre à jour quand l'artiste ou le titre change (null : aucune).
 * @param {Pick<Console, 'info' | 'warn'>} [options.logger]
 */
export function createSongEditor({ catalog, backupDir, playlists = null, logger = console }) {
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

  /**
   * Écrit des valeurs d'en-têtes dans un .txt (encodage d'origine conservé).
   * @param {import('./catalogService.js').Song} song
   * @param {string} file
   * @param {Buffer} buffer
   * @param {Record<string, string | null>} values
   */
  async function writeHeaders(song, file, buffer, values) {
    const { text, encoding } = decodeSongBuffer(buffer);
    const { text: updated, changes } = updateHeaders(text, values);
    if (changes.length === 0) return { changes, song, backup: null };
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
  }

  /**
   * Après un changement d'artiste ou de titre : mêmes valeurs dans les autres .txt du dossier
   * qui désignent la même chanson (le titre garde leur marque de duo), puis dans les playlists.
   *
   * @param {import('./catalogService.js').Song} before  Chanson avant modification.
   * @param {import('./catalogService.js').Song} after   Chanson modifiée.
   */
  async function propagateIdentity(before, after) {
    const oldArtist = before.artist ?? '';
    const oldTitle = before.title ?? '';
    const newArtist = after.artist ?? '';
    const newTitle = after.title ?? '';
    const baseKey = (/** @type {string | null} */ title) =>
      looseKey(titleWithoutDuetMark(title ?? ''));
    const siblings = catalog
      .getSongs()
      .filter(
        (other) =>
          other.id !== before.id &&
          other.folder === before.folder &&
          looseKey(other.artist ?? '') === looseKey(oldArtist) &&
          baseKey(other.title) === baseKey(oldTitle),
      );
    const renames = [
      { from: { artist: oldArtist, title: oldTitle }, to: { artist: newArtist, title: newTitle } },
    ];
    /** @type {{ txtFile: string, backup: string | null }[]} */
    const updated = [];
    /** @type {{ txtFile: string, code: string }[]} */
    const failed = [];
    for (const other of siblings) {
      /** @type {Record<string, string>} */
      const values = {};
      if (newArtist !== oldArtist) values.ARTIST = newArtist;
      if (newTitle !== oldTitle) {
        values.TITLE = `${titleWithoutDuetMark(newTitle)}${duetMarkOf(other.title ?? '')}`;
      }
      try {
        const { file, buffer } = await loadForWrite(other.id, other.modifiedAt);
        const result = await writeHeaders(other, file, buffer, values);
        if (result.changes.length > 0)
          updated.push({ txtFile: other.txtFile, backup: result.backup });
        renames.push({
          from: { artist: other.artist ?? '', title: other.title ?? '' },
          to: { artist: result.song.artist ?? '', title: result.song.title ?? '' },
        });
      } catch (error) {
        if (!(error instanceof SongEditError)) throw error;
        logger.warn(`Not updated: ${other.folder}/${other.txtFile} (${error.code})`);
        failed.push({ txtFile: other.txtFile, code: error.code });
      }
    }
    const playlistResult = playlists
      ? await playlists.renameSongEntries(renames)
      : { updated: [], failed: [] };
    return { related: { updated, failed }, playlists: playlistResult };
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
     * Répare les caractères mal encodés (texte UTF-8 relu en Windows-1252 puis réenregistré :
     * « Ã© » au lieu de « é »). L'encodage du fichier et les fins de ligne sont conservés.
     * En simulation, renvoie seulement la liste des lignes modifiées.
     *
     * @param {string} id
     * @param {{ expectedModifiedAt: number, dryRun?: boolean }} request
     * @returns {Promise<{ changes: import('../parsers/mojibake.js').MojibakeLineChange[],
     *   song: import('./catalogService.js').Song, backup: string | null }>}
     * @throws {SongEditError}
     */
    async repairText(id, { expectedModifiedAt, dryRun = false }) {
      const { song, file, buffer } = await loadForWrite(id, expectedModifiedAt);
      const { text, encoding } = decodeSongBuffer(buffer);
      const { text: repaired, changes } = planMojibakeRepair(text);
      if (dryRun || changes.length === 0) return { changes, song, backup: null };

      let data;
      try {
        data = encodeSongText(repaired, encoding);
      } catch (error) {
        if (!(error instanceof UnencodableCharacterError)) throw error;
        throw new SongEditError(
          'UNENCODABLE_CHARACTER',
          `"${error.character}" cannot be saved in this ${encoding} file`,
          422,
          { character: error.character, encoding },
        );
      }
      const result = await commit(song, file, data, `${changes.length} garbled line(s) repaired`);
      return { changes, ...result };
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
     *   song: import('./catalogService.js').Song, backup: string | null,
     *   related?: { updated: { txtFile: string, backup: string | null }[], failed: { txtFile: string, code: string }[] },
     *   playlists?: { updated: { file: string, backup: string }[], failed: { file: string, code: string }[] } }>}
     *   `related` et `playlists` : seulement si l'artiste ou le titre a changé.
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
      const { text } = decodeSongBuffer(buffer);
      applyDecimalSeparator(text, clean);
      checkMedley(text, clean);
      // Duo à l'ancien format : #DUETSINGERP1 est mis à jour plutôt que d'ajouter un #P1.
      for (const [header, legacy] of Object.entries(LEGACY_SINGER_HEADERS)) {
        if (!(header in clean)) continue;
        const hasLegacy = new RegExp(`^#${legacy}:`, 'im').test(text);
        if (hasLegacy && !new RegExp(`^#${header}:`, 'im').test(text)) {
          clean[legacy] = clean[header];
          delete clean[header];
        }
      }
      if (dryRun) return { changes: updateHeaders(text, clean).changes, song, backup: null };

      const result = await writeHeaders(song, file, buffer, clean);
      const identityChanged = result.changes.some(
        (c) => c.header === 'ARTIST' || c.header === 'TITLE',
      );
      if (!identityChanged) return result;
      return { ...result, ...(await propagateIdentity(song, result.song)) };
    },
  };
}

/** @typedef {ReturnType<typeof createSongEditor>} SongEditor */
