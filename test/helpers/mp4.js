// @ts-check
/**
 * Fabrique de petits fichiers MP4 synthétiques (seulement les boîtes utiles aux tests).
 * @module test/helpers/mp4
 */

/**
 * @param {string} type
 * @param {...Uint8Array} parts
 * @returns {Buffer}
 */
export function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/**
 * Piste d'un type donné (« vide », « soun ») avec une entrée stsd.
 * @param {{ handler: string, codec: string, width?: number, height?: number }} options
 */
export function track({ handler, codec, width = 0, height = 0 }) {
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
  const entryBody = Buffer.alloc(70);
  entryBody.writeUInt16BE(width, 24);
  entryBody.writeUInt16BE(height, 26);
  const entry = box(codec, entryBody);
  const countAndFlags = Buffer.alloc(8);
  countAndFlags.writeUInt32BE(1, 4);
  const stsd = box('stsd', countAndFlags, entry);
  return box(
    'trak',
    box('tkhd', Buffer.alloc(84)),
    box('mdia', hdlr, box('minf', box('stbl', stsd))),
  );
}

/**
 * Fichier MP4 complet : ftyp, puis mdat (données) et moov dans l'ordre demandé.
 * @param {{ tracks: Buffer[], moovFirst?: boolean, mdatSize?: number }} options
 */
export function mp4File({ tracks, moovFirst = false, mdatSize = 1000 }) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(mdatSize));
  const moov = box('moov', box('mvhd', Buffer.alloc(100)), ...tracks);
  return Buffer.concat(moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}

/** MP4 H.264 1280×720 avec une piste audio avant la vidéo. */
export const H264_720P = () =>
  mp4File({
    tracks: [
      track({ handler: 'soun', codec: 'mp4a' }),
      track({ handler: 'vide', codec: 'avc1', width: 1280, height: 720 }),
    ],
  });
