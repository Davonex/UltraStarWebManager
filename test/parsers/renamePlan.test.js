// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_NAMING } from '../../src/parsers/naming.js';
import { buildRenamePlan, nameError } from '../../src/parsers/renamePlan.js';
import { parseUltrastarTxt } from '../../src/parsers/ultrastarTxt.js';

/**
 * Entrée d'un .txt à partir de son texte.
 * @param {string} txtFile
 * @param {string} text
 */
function txt(txtFile, text) {
  const parsed = parseUltrastarTxt(Buffer.from(text, 'utf8'));
  return { txtFile, text, headers: parsed.headers, isDuet: parsed.stats.isDuet };
}

const SOLO = [
  '#TITLE:Bohemian Rhapsody',
  '#ARTIST:Queen',
  '#MP3:Queen - Bohemian Rhapsody.mp3',
  '#VIDEO:clip.mp4',
  '#COVER:cover.jpg',
  '#BPM:300',
  ': 0 4 0 Is',
  'E',
  '',
].join('\r\n');
const DUET = [
  '#TITLE:Bohemian Rhapsody [DUET]',
  '#ARTIST:Queen',
  '#P1:Freddie',
  '#P2:Brian',
  '#MP3:Queen - Bohemian Rhapsody.mp3',
  '#VIDEO:CLIP.mp4',
  '#COVER:cover.jpg',
  '#BPM:300',
  'P1',
  ': 0 4 0 Is',
  'P2',
  ': 8 4 0 this',
  'E',
  '',
].join('\r\n');

function samplePlan(overrides = {}) {
  return buildRenamePlan({
    folderName: 'queen-bohemian',
    fileNames: [
      'bohemian.txt',
      'bohemian duet.txt',
      'Queen - Bohemian Rhapsody.mp3',
      'clip.mp4',
      'cover.jpg',
      'notes.txt.bak',
      'old.jpg',
      '.cache',
    ],
    txts: [txt('bohemian.txt', SOLO), txt('bohemian duet.txt', DUET)],
    rules: DEFAULT_NAMING,
    overrides,
  });
}

/** @param {ReturnType<typeof samplePlan>} plan */
const byName = (plan) => Object.fromEntries(plan.files.map((e) => [e.from, e]));

describe('buildRenamePlan', () => {
  it('propose les noms de la norme pour le dossier et tous les fichiers cités', () => {
    const plan = samplePlan();
    assert.equal(plan.artist, 'Queen');
    assert.equal(plan.title, 'Bohemian Rhapsody'); // marque de duo retirée
    assert.equal(plan.folder?.to, 'Queen - Bohemian Rhapsody');
    const files = byName(plan);
    assert.equal(files['bohemian.txt'].to, 'Queen - Bohemian Rhapsody.txt');
    assert.equal(files['bohemian duet.txt'].to, 'Queen - Bohemian Rhapsody [DUET].txt');
    assert.equal(files['clip.mp4'].to, 'Queen - Bohemian Rhapsody.mp4');
    assert.equal(files['cover.jpg'].to, 'Queen - Bohemian Rhapsody [CO].jpg');
    assert.equal(files['Queen - Bohemian Rhapsody.mp3'].action, 'unchanged');
    assert.equal(files['notes.txt.bak'].kind, 'other');
    assert.equal(files['notes.txt.bak'].action, 'unchanged'); // aucun nom proposé
    assert.equal(files['.cache'], undefined); // fichiers cachés absents
    // Fichier partagé : cité par les deux .txt
    assert.deepEqual(files['clip.mp4'].usedBy, ['bohemian.txt', 'bohemian duet.txt']);
    assert.equal(plan.renameCount, 5);
    assert.equal(plan.errorCount, 0);
  });

  it('corrige les en-têtes de chaque .txt, sans toucher au reste', () => {
    const plan = samplePlan();
    const duet = plan.txts.find((t) => t.txtFile === 'bohemian duet.txt');
    assert.equal(duet?.newTxtFile, 'Queen - Bohemian Rhapsody [DUET].txt');
    assert.deepEqual(
      duet?.changes.map((c) => `${c.header}:${c.after}`),
      ['VIDEO:Queen - Bohemian Rhapsody.mp4', 'COVER:Queen - Bohemian Rhapsody [CO].jpg'],
    );
    assert.equal(
      duet?.text,
      DUET.replace('#VIDEO:CLIP.mp4', '#VIDEO:Queen - Bohemian Rhapsody.mp4').replace(
        '#COVER:cover.jpg',
        '#COVER:Queen - Bohemian Rhapsody [CO].jpg',
      ),
    );
  });

  it('prend en compte les noms saisis et signale les conflits', () => {
    const plan = samplePlan({
      folder: 'Queen - Bohemian Rhapsody (live)',
      files: {
        'cover.jpg': 'OLD.jpg', // déjà pris par un autre fichier (casse ignorée)
        'clip.mp4': 'clip.avi', // extension changée
        'bohemian.txt': 'a:b.txt', // caractère interdit
      },
    });
    const files = byName(plan);
    assert.equal(plan.folder?.to, 'Queen - Bohemian Rhapsody (live)');
    assert.equal(files['cover.jpg'].error, 'DUPLICATE');
    assert.equal(files['clip.mp4'].error, 'EXTENSION_CHANGED');
    assert.equal(files['bohemian.txt'].error, 'FORBIDDEN_CHARACTER');
    assert.equal(plan.errorCount, 3);
  });

  it('remettre le nom actuel annule le renommage de cet élément', () => {
    const plan = samplePlan({ files: { 'cover.jpg': 'cover.jpg' } });
    assert.equal(byName(plan)['cover.jpg'].action, 'unchanged');
    const solo = plan.txts.find((t) => t.txtFile === 'bohemian.txt');
    assert.deepEqual(
      solo?.changes.map((c) => c.header),
      ['VIDEO'],
    );
  });

  it('une vidéo qui sert aussi de musique suit le modèle audio, #MP3 et #VIDEO corrigés', () => {
    const text =
      '#TITLE:Zen\n#ARTIST:Zazie\n#MP3:clip.mp4\n#VIDEO:clip.mp4\n#BPM:300\n: 0 4 0 a\nE\n';
    const plan = buildRenamePlan({
      folderName: 'Zazie - Zen',
      fileNames: ['Zazie - Zen.txt', 'clip.mp4'],
      txts: [txt('Zazie - Zen.txt', text)],
    });
    assert.equal(plan.folder?.action, 'unchanged');
    assert.equal(byName(plan)['clip.mp4'].kind, 'audio');
    assert.deepEqual(
      plan.txts[0].changes.map((c) => `${c.header}:${c.after}`),
      ['MP3:Zazie - Zen.mp4', 'VIDEO:Zazie - Zen.mp4'],
    );
  });

  it('changement de casse seule : renommage proposé', () => {
    const text = '#TITLE:Zen\n#ARTIST:Zazie\n#MP3:zazie - zen.mp3\n#BPM:300\n: 0 4 0 a\nE\n';
    const plan = buildRenamePlan({
      folderName: 'Zazie - Zen',
      fileNames: ['Zazie - Zen.txt', 'zazie - zen.mp3'],
      txts: [txt('Zazie - Zen.txt', text)],
      overrides: { files: { 'zazie - zen.mp3': 'Zazie - Zen.mp3' } },
    });
    const audio = byName(plan)['zazie - zen.mp3'];
    assert.equal(audio.action, 'rename');
    assert.equal(audio.error, null); // pas un doublon de lui-même
  });

  it('sans règle active ou sans artiste/titre, rien n’est proposé', () => {
    const rules = { ...DEFAULT_NAMING, cover: { enabled: false, pattern: '{artist}' } };
    const plan = samplePlan();
    assert.equal(byName(plan)['cover.jpg'].action, 'rename');
    const noCover = buildRenamePlan({
      folderName: 'x',
      fileNames: ['bohemian.txt', 'cover.jpg'],
      txts: [txt('bohemian.txt', SOLO)],
      rules,
    });
    assert.equal(byName(noCover)['cover.jpg'].action, 'unchanged');
    const anonymous = buildRenamePlan({
      folderName: 'x',
      fileNames: ['a.txt'],
      txts: [txt('a.txt', '#BPM:300\n: 0 4 0 a\nE\n')],
    });
    assert.equal(anonymous.artist, null);
    assert.equal(anonymous.renameCount, 0);
  });
});

describe('nameError', () => {
  it('fond = pochette, seule image : #BACKGROUND retiré, pochette renommée en [CO]', () => {
    const text = [
      '#TITLE:Easy',
      '#ARTIST:Phil',
      '#MP3:Phil - Easy.mp3',
      '#COVER:img.jpg',
      '#BACKGROUND:img.jpg',
      '#BPM:300',
      ': 0 4 0 la',
      'E',
      '',
    ].join('\n');
    const plan = buildRenamePlan({
      folderName: 'Phil - Easy',
      fileNames: ['Phil - Easy.txt', 'Phil - Easy.mp3', 'img.jpg'],
      txts: [txt('Phil - Easy.txt', text)],
    });
    const image = plan.files.find((f) => f.from === 'img.jpg');
    assert.equal(image?.kind, 'cover');
    assert.equal(image?.to, 'Phil - Easy [CO].jpg');
    assert.deepEqual(plan.txts[0].changes, [
      { header: 'COVER', before: 'img.jpg', after: 'Phil - Easy [CO].jpg' },
      { header: 'BACKGROUND', before: 'img.jpg', after: null },
    ]);
    assert.doesNotMatch(plan.txts[0].text, /#BACKGROUND/);
    assert.equal(plan.txtChangeCount, 1);

    // Déjà bien nommée : aucun renommage, seul le .txt change
    const named = buildRenamePlan({
      folderName: 'Phil - Easy',
      fileNames: ['Phil - Easy.txt', 'Phil - Easy.mp3', 'Phil - Easy [CO].jpg'],
      txts: [txt('Phil - Easy.txt', text.replaceAll('img.jpg', 'Phil - Easy [CO].jpg'))],
    });
    assert.equal(named.renameCount, 0);
    assert.equal(named.txtChangeCount, 1);
    assert.equal(named.txts[0].changes[0].header, 'BACKGROUND');

    // Autre image dans le dossier : #BACKGROUND gardé
    const other = buildRenamePlan({
      folderName: 'Phil - Easy',
      fileNames: ['Phil - Easy.txt', 'Phil - Easy.mp3', 'img.jpg', 'fond.png'],
      txts: [txt('Phil - Easy.txt', text)],
    });
    assert.match(other.txts[0].text, /#BACKGROUND:Phil - Easy \[CO\]\.jpg/);
  });

  it('refuse les noms invalides sous Windows', () => {
    assert.equal(nameError('Queen - Bohemian Rhapsody.mp3'), null);
    assert.equal(nameError(''), 'EMPTY');
    assert.equal(nameError('AC/DC.mp3'), 'FORBIDDEN_CHARACTER');
    assert.equal(nameError('titre.'), 'TRAILING_DOT_OR_SPACE');
    assert.equal(nameError('CON.txt'), 'RESERVED_NAME');
    assert.equal(nameError('x'.repeat(201)), 'TOO_LONG');
  });
});
