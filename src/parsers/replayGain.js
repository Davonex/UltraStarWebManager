// @ts-check
/**
 * Tags ReplayGain d'un fichier audio : gain (dB) et crête (amplitude, 1 = 0 dBFS) de la
 * piste et de l'album. FONCTIONS PURES : elles reçoivent des octets, jamais un chemin.
 *
 * Emplacements lus (ceux des outils courants : foobar2000, MP3Gain, beets, mp3tag…) :
 * - ID3v2.2 / 2.3 / 2.4, cadres TXXX « REPLAYGAIN_TRACK_GAIN »… (début du fichier) ;
 * - APEv2 (fin du fichier, éventuellement suivi d'un tag ID3v1 de 128 octets).
 *
 * @module parsers/replayGain
 */

/**
 * @typedef {object} ReplayGain  Valeurs trouvées (null = absente).
 * @property {number | null} trackGain  dB
 * @property {number | null} trackPeak
 * @property {number | null} albumGain  dB
 * @property {number | null} albumPeak
 * @property {'id3' | 'ape'} source
 */

/** Taille de l'en-tête ID3v2 et du pied APEv2. */
export const ID3_HEADER_SIZE = 10;
export const APE_FOOTER_SIZE = 32;
const ID3V1_SIZE = 128;

const KEYS = /** @type {const} */ ({
  replaygain_track_gain: 'trackGain',
  replaygain_track_peak: 'trackPeak',
  replaygain_album_gain: 'albumGain',
  replaygain_album_peak: 'albumPeak',
});

/**
 * Taille « synchsafe » (7 bits utiles par octet), utilisée par ID3v2.4.
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function synchsafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

/**
 * « -10.27 dB », « +3,5 dB », « 0.988 » → nombre (null si illisible).
 * @param {string} text
 * @returns {number | null}
 */
export function parseGainValue(text) {
  const match = /^\s*([+-]?\d+(?:[.,]\d+)?)/.exec(text);
  return match ? Number(match[1].replace(',', '.')) : null;
}

/**
 * Taille totale du tag ID3v2 (en-tête compris) annoncée par les 10 premiers octets,
 * ou 0 s'il n'y en a pas.
 * @param {Uint8Array} header
 * @returns {number}
 */
export function id3TagSize(header) {
  if (
    header.length < ID3_HEADER_SIZE ||
    String.fromCharCode(header[0], header[1], header[2]) !== 'ID3'
  )
    return 0;
  return ID3_HEADER_SIZE + synchsafe(header, 6) + (header[5] & 0x10 ? ID3_HEADER_SIZE : 0);
}

/**
 * Texte d'un cadre ID3 selon son octet d'encodage.
 * @param {number} encoding  0 latin1, 1 UTF-16 avec BOM, 2 UTF-16BE, 3 UTF-8
 * @param {Uint8Array} bytes
 */
function decodeText(encoding, bytes) {
  if (encoding === 1 || encoding === 2) {
    let data = bytes;
    let littleEndian = encoding === 1;
    if (data[0] === 0xff && data[1] === 0xfe) data = data.subarray(2);
    else if (data[0] === 0xfe && data[1] === 0xff) {
      data = data.subarray(2);
      littleEndian = false;
    }
    return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be').decode(data);
  }
  return new TextDecoder(encoding === 3 ? 'utf-8' : 'latin1').decode(bytes);
}

/**
 * Description et valeur d'un cadre TXXX (séparées par un zéro, sur 1 ou 2 octets).
 * @param {Uint8Array} body
 * @returns {[string, string] | null}
 */
function readTxxx(body) {
  const encoding = body[0];
  const data = body.subarray(1);
  const wide = encoding === 1 || encoding === 2;
  for (let i = 0; i + (wide ? 1 : 0) < data.length; i += wide ? 2 : 1) {
    if (data[i] === 0 && (!wide || data[i + 1] === 0)) {
      const end = i;
      const valueStart = i + (wide ? 2 : 1);
      const clean = (/** @type {string} */ s) => s.replace(/\0+$/, '').trim();
      return [
        clean(decodeText(encoding, data.subarray(0, end))),
        clean(decodeText(encoding, data.subarray(valueStart))),
      ];
    }
  }
  return null;
}

/**
 * @param {Record<string, string>} values  Clés en minuscules.
 * @param {'id3' | 'ape'} source
 * @returns {ReplayGain | null}
 */
function toReplayGain(values, source) {
  /** @type {ReplayGain} */
  const result = { trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source };
  let found = false;
  for (const [key, field] of Object.entries(KEYS)) {
    if (values[key] === undefined) continue;
    const value = parseGainValue(values[key]);
    if (value !== null && Number.isFinite(value)) {
      result[field] = value;
      found = true;
    }
  }
  return found ? result : null;
}

/**
 * ReplayGain des cadres TXXX d'un tag ID3v2 complet (en-tête compris).
 * @param {Uint8Array} tag
 * @returns {ReplayGain | null}
 */
export function parseId3ReplayGain(tag) {
  if (id3TagSize(tag) === 0) return null;
  const version = tag[3];
  const flags = tag[5];
  let bytes = tag.subarray(0, Math.min(tag.length, id3TagSize(tag)));
  // Désynchronisation de tout le tag (v2.2 / v2.3) : FF 00 → FF.
  if (flags & 0x80 && version < 4) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      out.push(bytes[i]);
      if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
    }
    bytes = Uint8Array.from(out);
  }
  let offset = ID3_HEADER_SIZE;
  if (flags & 0x40 && version >= 3) {
    // En-tête étendu : on le saute.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    offset += version === 4 ? synchsafe(bytes, offset) : 4 + view.getUint32(offset);
  }
  const idSize = version === 2 ? 3 : 4;
  const headerSize = version === 2 ? 6 : 10;
  /** @type {Record<string, string>} */
  const values = {};
  while (offset + headerSize <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + idSize));
    if (!/^[A-Z0-9]+$/.test(id)) break; // remplissage (zéros) : fin des cadres
    let size;
    if (version === 2)
      size = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5];
    else if (version === 4) size = synchsafe(bytes, offset + 4);
    else
      size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset + 4);
    const start = offset + headerSize;
    const end = start + size;
    if (size <= 0 || end > bytes.length) break;
    if (id === 'TXXX' || id === 'TXX') {
      const pair = readTxxx(bytes.subarray(start, end));
      if (pair) values[pair[0].toLowerCase()] = pair[1];
    }
    offset = end;
  }
  return toReplayGain(values, 'id3');
}

/**
 * Position et taille du tag APEv2 d'après la fin du fichier (pied « APETAGEX »).
 * @param {Uint8Array} tail  Derniers octets du fichier (au moins 32 + 128).
 * @param {number} fileSize
 * @returns {{ start: number, size: number } | null}  Corps du tag (items), sans le pied.
 */
export function locateApeTag(tail, fileSize) {
  for (const skip of [0, ID3V1_SIZE]) {
    const at = tail.length - skip - APE_FOOTER_SIZE;
    if (at < 0) continue;
    if (new TextDecoder('latin1').decode(tail.subarray(at, at + 8)) !== 'APETAGEX') continue;
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const tagSize = view.getUint32(at + 12, true); // items + pied
    const footerOffset = fileSize - skip - APE_FOOTER_SIZE;
    return { start: footerOffset - (tagSize - APE_FOOTER_SIZE), size: tagSize - APE_FOOTER_SIZE };
  }
  return null;
}

/**
 * ReplayGain des items d'un tag APEv2 (corps, sans pied).
 * @param {Uint8Array} items
 * @returns {ReplayGain | null}
 */
export function parseApeReplayGain(items) {
  const view = new DataView(items.buffer, items.byteOffset, items.byteLength);
  /** @type {Record<string, string>} */
  const values = {};
  let offset = 0;
  while (offset + 8 < items.length) {
    const valueSize = view.getUint32(offset, true);
    let keyEnd = offset + 8;
    while (keyEnd < items.length && items[keyEnd] !== 0) keyEnd++;
    const key = new TextDecoder('latin1').decode(items.subarray(offset + 8, keyEnd)).toLowerCase();
    const valueStart = keyEnd + 1;
    if (valueStart + valueSize > items.length) break;
    values[key] = new TextDecoder('utf-8').decode(
      items.subarray(valueStart, valueStart + valueSize),
    );
    offset = valueStart + valueSize;
  }
  return toReplayGain(values, 'ape');
}

/** Tag ID3 que l'écrivain ne sait pas modifier sans risque. */
export class UnsupportedTagError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`Unsupported ID3 tag: ${reason}`);
    this.name = 'UnsupportedTagError';
  }
}

/**
 * « -2.54 dB », « +1.20 dB » (format des tags REPLAYGAIN_*_GAIN).
 * @param {number} gain
 */
export function formatGain(gain) {
  return `${gain > 0 ? '+' : ''}${gain.toFixed(2)} dB`;
}

/**
 * Taille sur 4 octets, normale (v2.3) ou « synchsafe » (v2.4).
 * @param {number} size
 * @param {boolean} safe
 */
function sizeBytes(size, safe) {
  return safe
    ? Uint8Array.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
    : Uint8Array.from([(size >>> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff]);
}

/**
 * Cadre TXXX « description = valeur » (texte latin1 : les valeurs sont en ASCII).
 * @param {number} version  3 ou 4
 * @param {string} description
 * @param {string} value
 */
function txxxFrame(version, description, value) {
  const body = Uint8Array.from([0, ...Buffer.from(`${description}\0${value}`, 'latin1')]);
  return Uint8Array.from([
    ...Buffer.from('TXXX'),
    ...sizeBytes(body.length, version === 4),
    0,
    0,
    ...body,
  ]);
}

/**
 * Nouveau tag ID3v2 avec les valeurs ReplayGain données : les autres cadres (titre,
 * pochette…) sont recopiés octet pour octet, les anciens cadres ReplayGain remplacés.
 * Sans tag d'origine, un tag ID3v2.3 est créé (lu par tous les lecteurs).
 *
 * @param {Uint8Array | null} oldTag  Tag d'origine complet (en-tête compris), ou null.
 * @param {Record<string, string>} values  Ex. { REPLAYGAIN_TRACK_GAIN: '-2.54 dB' }.
 * @returns {Uint8Array}
 * @throws {UnsupportedTagError}  ID3v2.2, désynchronisation ou pied v2.4.
 */
export function buildId3WithReplayGain(oldTag, values) {
  const version = oldTag ? oldTag[3] : 3;
  const flags = oldTag ? oldTag[5] : 0;
  if (version !== 3 && version !== 4) throw new UnsupportedTagError(`version 2.${version}`);
  if (flags & 0x80) throw new UnsupportedTagError('unsynchronisation');
  if (flags & 0x10) throw new UnsupportedTagError('footer');

  /** @type {Uint8Array[]} */
  const kept = [];
  let padding = 0;
  if (oldTag) {
    const end = Math.min(oldTag.length, id3TagSize(oldTag));
    let offset = ID3_HEADER_SIZE;
    if (flags & 0x40) {
      // En-tête étendu : recopié tel quel.
      const view = new DataView(oldTag.buffer, oldTag.byteOffset, oldTag.byteLength);
      const extSize = version === 4 ? synchsafe(oldTag, offset) : 4 + view.getUint32(offset);
      kept.push(oldTag.subarray(offset, offset + extSize));
      offset += extSize;
    }
    const keys = new Set(Object.keys(values).map((k) => k.toLowerCase()));
    while (offset + 10 <= end) {
      const id = String.fromCharCode(...oldTag.subarray(offset, offset + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break; // remplissage
      const size =
        version === 4
          ? synchsafe(oldTag, offset + 4)
          : new DataView(oldTag.buffer, oldTag.byteOffset).getUint32(offset + 4);
      const frameEnd = offset + 10 + size;
      if (size <= 0 || frameEnd > end) throw new UnsupportedTagError('damaged frame');
      const frame = oldTag.subarray(offset, frameEnd);
      const replaced =
        id === 'TXXX' && keys.has((readTxxx(frame.subarray(10))?.[0] ?? '').toLowerCase());
      if (!replaced) kept.push(frame);
      offset = frameEnd;
    }
    padding = Math.max(0, end - offset);
  }

  const added = Object.entries(values).map(([key, value]) => txxxFrame(version, key, value));
  const body = [...kept, ...added];
  const bodySize = body.reduce((sum, part) => sum + part.length, 0) + padding;
  const header = Uint8Array.from([
    ...Buffer.from('ID3'),
    version,
    0,
    flags & 0x40, // seul l'indicateur d'en-tête étendu est conservé
    ...sizeBytes(bodySize, true), // la taille du tag est toujours « synchsafe »
  ]);
  const tag = new Uint8Array(ID3_HEADER_SIZE + bodySize);
  tag.set(header, 0);
  let at = ID3_HEADER_SIZE;
  for (const part of body) {
    tag.set(part, at);
    at += part.length;
  }
  return tag; // le reste (remplissage) est déjà à zéro
}
