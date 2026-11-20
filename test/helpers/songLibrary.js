// @ts-check
/**
 * Fabrique une petite bibliothèque UltraStar dans un dossier temporaire pour les tests.
 * Jamais la vraie bibliothèque de l'utilisateur.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * @param {Record<string, string | Buffer>} files  chemin relatif → contenu
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
export async function createSongLibrary(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'usm-test-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Contenu minimal d'un fichier chanson.
 * @param {Record<string, string>} headers
 * @param {string} [body]
 */
export function songTxt(headers, body = ': 0 4 0 la\nE\n') {
  const lines = Object.entries(headers).map(([key, value]) => `#${key}:${value}`);
  return `${lines.join('\n')}\n${body}`;
}

/** Bibliothèque de référence utilisée par les tests du catalogue et de l'API. */
export const SAMPLE_LIBRARY = {
  'Zazie - Zen/Zazie - Zen.txt': songTxt({
    TITLE: 'Zen',
    ARTIST: 'Zazie',
    MP3: 'Zazie - Zen.mp3',
    COVER: 'Zazie - Zen.jpg',
    YEAR: '1995',
    GENRE: 'Pop, Variété',
    LANGUAGE: 'French',
    BPM: '300',
  }),
  'Zazie - Zen/Zazie - Zen.mp3': '',
  'Zazie - Zen/Zazie - Zen.jpg': '',
  // Casse différente entre le .txt et le disque, sous-dossier, encodage Windows-1252
  'Francais/Édith Piaf - Hymne/piaf.txt': Buffer.from(
    songTxt({ TITLE: "L'hymne à l'amour", ARTIST: 'Édith Piaf', MP3: 'PIAF.MP3', BPM: '200' }),
    'latin1',
  ),
  'Francais/Édith Piaf - Hymne/piaf.mp3': '',
  'Francais/Édith Piaf - Hymne/piaf [CO].jpg': '',
  // Deux .txt dans le même dossier, dont un duo ; vidéo absente
  'Duo - Test/duo.txt': songTxt(
    {
      TITLE: 'Test',
      ARTIST: 'Duo',
      AUDIO: 'duo.mp3',
      VIDEO: 'duo.mp4',
      BPM: '250',
      P1: 'A',
      P2: 'B',
    },
    'P1\n: 0 4 0 la\nP2\n: 8 4 0 li\nE\n',
  ),
  'Duo - Test/duo (instru).txt': songTxt({
    TITLE: 'Test (instru)',
    ARTIST: 'Duo',
    MP3: 'duo.mp3',
    BPM: '250',
  }),
  'Duo - Test/duo.mp3': '',
  // Fichiers à ignorer
  'Duo - Test/readme.txt': 'Ceci n’est pas une chanson.\n',
  '.cache/hidden.txt': songTxt({ TITLE: 'Cachée', ARTIST: 'X', MP3: 'x.mp3', BPM: '1' }),
};
