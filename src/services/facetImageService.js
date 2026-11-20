// @ts-check
/**
 * Images des catégories (langues, décennies, éditions) fournies par l'installation
 * d'UltraStar Deluxe, dossier `covers` :
 *
 *   covers/Language/French.jpg   → langue « French »
 *   covers/Decade/1990.jpg       → décennie 1990 (repli : covers/1990.jpg)
 *   covers/ABBA.jpg              → édition « ABBA » (catégorie #EDITION d'UltraStar)
 *
 * Seuls les noms de fichiers sont lus au démarrage ; ce service ne modifie jamais ce dossier.
 *
 * @module services/facetImageService
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from '../utils/safePath.js';
import { looseKey } from '../utils/text.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** @typedef {'language' | 'decade' | 'edition'} ImageFacet */

/**
 * Sous-dossiers explorés pour chaque facette, par ordre de priorité ('' = racine de covers).
 * @type {Readonly<Record<ImageFacet, readonly string[]>>}
 */
export const FACET_FOLDERS = Object.freeze({
  language: ['Language'],
  decade: ['Decade', ''],
  edition: [''],
});

const DECADE_NAME = /^\d{4}$/;

/**
 * Filtre des noms de fichiers acceptés par facette : la racine de `covers` mélange
 * décennies (« 1990 ») et éditions (« ABBA »). Une édition peut aussi s'appeler « 1990 » :
 * elle utilise alors l'image de la décennie.
 * @type {Readonly<Record<ImageFacet, (name: string) => boolean>>}
 */
const NAME_FILTERS = Object.freeze({
  language: () => true,
  decade: (name) => DECADE_NAME.test(name),
  edition: () => true,
});

/**
 * Orthographes des fichiers d'UltraStar Deluxe différentes du nom anglais habituel.
 * @type {Readonly<Record<string, string>>}
 */
const LANGUAGE_ALIASES = Object.freeze({
  finnish: 'finish',
  lithuanian: 'lituanian',
  filipino: 'philipino',
});

/**
 * @typedef {object} FacetImage
 * @property {string} name          Nom affichable (fichier sans extension).
 * @property {string} relativePath  Chemin relatif à `covers`.
 */

/**
 * Liste les images d'un sous-dossier (absent = liste vide).
 * @param {string} root
 * @param {string} folder
 * @returns {Promise<FacetImage[]>}
 */
async function listImages(root, folder) {
  try {
    const entries = await readdir(path.join(root, folder), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      .map((e) => ({
        name: path.basename(e.name, path.extname(e.name)),
        relativePath: path.join(folder, e.name),
      }));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * @param {object} options
 * @param {string | null} options.dir  Dossier `covers` (null = non configuré).
 * @param {Pick<Console, 'info' | 'warn'>} [options.logger]
 */
export function createFacetImages({ dir, logger = console }) {
  /** @type {Map<ImageFacet, Map<string, FacetImage>>} */
  let index = new Map();

  /**
   * @param {ImageFacet} facet
   * @param {string} value
   * @returns {string}
   */
  function keyOf(facet, value) {
    const key = looseKey(value);
    return facet === 'language' ? (LANGUAGE_ALIASES[key] ?? key) : key;
  }

  return {
    /** Lit les noms des images disponibles. Un dossier absent n'est pas une erreur. */
    async load() {
      if (!dir) return;
      /** @type {Map<ImageFacet, Map<string, FacetImage>>} */
      const next = new Map();
      try {
        for (const facet of /** @type {ImageFacet[]} */ (Object.keys(FACET_FOLDERS))) {
          /** @type {Map<string, FacetImage>} */
          const images = new Map();
          for (const folder of FACET_FOLDERS[facet]) {
            for (const image of await listImages(dir, folder)) {
              if (!NAME_FILTERS[facet](image.name)) continue;
              const key = looseKey(image.name);
              if (!images.has(key)) images.set(key, image); // premier dossier prioritaire
            }
          }
          next.set(facet, images);
        }
        index = next;
        const total = [...next.values()].reduce((sum, m) => sum + m.size, 0);
        logger.info(`Category images: ${total} found in ${dir}`);
      } catch (error) {
        logger.warn(
          `Category images unavailable: ${error instanceof Error ? error.message : error}`,
        );
      }
    },

    /**
     * Noms des valeurs illustrées, par facette (pour l'interface).
     * @returns {Record<ImageFacet, string[]>}
     */
    list() {
      /** @param {ImageFacet} facet */
      const names = (facet) => [...(index.get(facet)?.values() ?? [])].map((image) => image.name);
      const languageImages = index.get('language');
      const aliases = Object.entries(LANGUAGE_ALIASES)
        .filter(([, target]) => languageImages?.has(target))
        .map(([alias]) => alias);
      return {
        language: [...names('language'), ...aliases],
        decade: names('decade'),
        edition: names('edition'),
      };
    },

    /**
     * Chemin absolu de l'image d'une valeur, ou null. La valeur n'est jamais utilisée pour
     * construire un chemin : elle sert seulement de clé dans l'index des fichiers existants.
     *
     * @param {string} facet
     * @param {string} value
     * @returns {string | null}
     */
    resolve(facet, value) {
      if (!dir || !(facet in FACET_FOLDERS)) return null;
      const image = index
        .get(/** @type {ImageFacet} */ (facet))
        ?.get(keyOf(/** @type {ImageFacet} */ (facet), value));
      return image ? resolveInside(dir, image.relativePath) : null;
    },
  };
}

/** @typedef {ReturnType<typeof createFacetImages>} FacetImages */
