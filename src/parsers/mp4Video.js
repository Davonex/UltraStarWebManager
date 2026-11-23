// @ts-check
/**
 * Lecture minimale de l'en-tête d'un fichier MP4 (ISO BMFF) : codec et résolution de la
 * piste vidéo. FONCTIONS PURES : elles reçoivent des octets, jamais un chemin.
 *
 * Structure utile : moov → trak → mdia → (hdlr = « vide ») et minf → stbl → stsd → entrée
 * d'échantillon dont le type donne le codec (avc1 = H.264) et qui contient largeur/hauteur.
 *
 * @module parsers/mp4Video
 */

/** Codecs (type de l'entrée stsd) → nom court affiché. */
const CODEC_NAMES = Object.freeze({
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  av01: 'av1',
  vp09: 'vp9',
  mp4v: 'mpeg4',
});

/** Extensions de fichier du format MP4. */
export const MP4_EXTENSIONS = Object.freeze(['.mp4', '.m4v']);

/**
 * @typedef {object} VideoInfo Description d'une vidéo (null = inconnu).
 * @property {string} container  Format du fichier, d'après l'extension (« mp4 », « avi »…).
 * @property {string | null} codec  « h264 », « hevc », « mpeg4 »…
 * @property {number | null} width
 * @property {number | null} height
 */

/**
 * @typedef {object} BoxHeader
 * @property {string} type
 * @property {number} start       Début de la boîte (octet).
 * @property {number} headerSize  8, ou 16 pour une taille sur 64 bits.
 * @property {number} size        Taille totale (en-tête compris). 0 = jusqu'à la fin.
 */

/**
 * Lit l'en-tête de boîte qui commence à `offset` (null si les octets manquent).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {BoxHeader | null}
 */
export function readBoxHeader(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset);
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    size = Number(view.getBigUint64(offset + 8));
    headerSize = 16;
  }
  if (size !== 0 && size < headerSize) return null; // taille incohérente
  return { type, start: offset, headerSize, size };
}

/**
 * Boîtes enfants contenues entre `from` et `to`.
 * @param {Uint8Array} bytes
 * @param {number} from
 * @param {number} to
 * @returns {BoxHeader[]}
 */
function children(bytes, from, to) {
  const boxes = [];
  let offset = from;
  while (offset < to) {
    const box = readBoxHeader(bytes, offset);
    if (!box) break;
    const end = box.size === 0 ? to : box.start + box.size;
    if (end > to) break; // boîte tronquée
    boxes.push(box);
    offset = end;
  }
  return boxes;
}

/**
 * @param {Uint8Array} bytes
 * @param {BoxHeader} parent
 * @param {string[]} path  Types successifs à suivre.
 * @returns {BoxHeader | null}
 */
function find(bytes, parent, path) {
  let current = parent;
  for (const type of path) {
    const next = children(
      bytes,
      current.start + current.headerSize,
      current.start + current.size,
    ).find((box) => box.type === type);
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * Codec et résolution de la première piste vidéo, à partir du contenu complet de la boîte
 * `moov` (en-tête compris).
 *
 * @param {Uint8Array} moov
 * @returns {{ codec: string | null, width: number | null, height: number | null } | null}
 *   null s'il n'y a pas de piste vidéo lisible.
 */
export function parseMoov(moov) {
  const root = readBoxHeader(moov, 0);
  if (root?.type !== 'moov') return null;
  const box = { ...root, size: root.size === 0 ? moov.length : Math.min(root.size, moov.length) };
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);

  for (const trak of children(moov, box.start + box.headerSize, box.start + box.size)) {
    if (trak.type !== 'trak') continue;
    // hdlr : 4 octets version/drapeaux, 4 octets pre_defined, puis le type de piste.
    const hdlr = find(moov, trak, ['mdia', 'hdlr']);
    const handlerAt = hdlr ? hdlr.start + hdlr.headerSize + 8 : -1;
    if (!hdlr || handlerAt + 4 > moov.length) continue;
    if (String.fromCharCode(...moov.subarray(handlerAt, handlerAt + 4)) !== 'vide') continue;

    // stsd : 4 octets version/drapeaux, 4 octets nombre d'entrées, puis la première entrée.
    const stsd = find(moov, trak, ['mdia', 'minf', 'stbl', 'stsd']);
    const entry = stsd ? readBoxHeader(moov, stsd.start + stsd.headerSize + 8) : null;
    if (!entry) return { codec: null, width: null, height: null };
    const codec =
      /** @type {Record<string, string>} */ (CODEC_NAMES)[entry.type] ?? entry.type.trim();
    // Entrée visuelle : largeur et hauteur à 24 et 26 octets après l'en-tête de l'entrée.
    const sizeAt = entry.start + entry.headerSize + 24;
    if (sizeAt + 4 > moov.length) return { codec, width: null, height: null };
    return { codec, width: view.getUint16(sizeAt), height: view.getUint16(sizeAt + 2) };
  }
  return null;
}

/** Taille maximale utile d'une vidéo de karaoké (fond derrière les paroles) : 1080p. */
export const MAX_VIDEO_WIDTH = 1920;
export const MAX_VIDEO_HEIGHT = 1080;

/**
 * Vidéo plus grande que 1080p (ex. 4K) : lourde à décoder pour UltraStar, sans gain visible.
 * Résolution inconnue → false.
 * @param {VideoInfo | null} info
 * @returns {boolean}
 */
export function isOversizedVideo(info) {
  return (
    info !== null && ((info.width ?? 0) > MAX_VIDEO_WIDTH || (info.height ?? 0) > MAX_VIDEO_HEIGHT)
  );
}

/**
 * Vidéo à convertir : pas en MP4 H.264, ou plus grande que 1080p.
 * @param {VideoInfo | null} info
 * @returns {boolean}
 */
export function needsConversion(info) {
  return info !== null && (!isRecommendedVideo(info) || isOversizedVideo(info));
}

/**
 * Vidéo recommandée : MP4 en H.264 (lue partout, décodage léger).
 * @param {VideoInfo | null} info
 * @returns {boolean}
 */
export function isRecommendedVideo(info) {
  return info !== null && info.container === 'mp4' && info.codec === 'h264';
}

/**
 * Format du fichier d'après son extension (« .M4V » → « mp4 », « .avi » → « avi »).
 * @param {string} fileName
 * @returns {string}
 */
export function containerOf(fileName) {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (MP4_EXTENSIONS.includes(extension)) return 'mp4';
  return fileName.includes('.') ? extension.slice(1) : 'unknown';
}
