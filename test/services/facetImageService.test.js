// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFacetImages } from '../../src/services/facetImageService.js';
import { createSongLibrary } from '../helpers/songLibrary.js';

const silentLogger = { info() {}, warn() {} };

describe('facetImageService', () => {
  /** @type {Awaited<ReturnType<typeof createSongLibrary>>} */
  let covers;
  /** @type {import('../../src/services/facetImageService.js').FacetImages} */
  let images;

  before(async () => {
    covers = await createSongLibrary({
      'Language/French.jpg': 'fr',
      'Language/Finish.jpg': 'fi',
      'Language/Kölsch.jpg': 'ksh',
      'Language/notes.txt': 'pas une image',
      'Decade/1990.jpg': 'decade-folder',
      '1990.jpg': 'decade-root',
      '1980.jpg': 'decade-root-only',
      'Alain Souchon.jpg': 'edition',
      'AC-DC.PNG': 'edition-png',
      'tag/love_song.jpg': 'tag',
      'tag/disney.jpg': 'tag',
    });
    images = createFacetImages({ dir: covers.root, logger: silentLogger });
    await images.load();
  });

  after(() => covers.cleanup());

  /** @param {string | null} file */
  const relative = (file) =>
    file ? path.relative(covers.root, file).split(path.sep).join('/') : null;

  it('liste les valeurs illustrées par facette (images seulement)', () => {
    const list = images.list();
    assert.deepEqual(list.language.sort(), ['Finish', 'French', 'Kölsch', 'finnish']);
    assert.deepEqual(list.decade.sort(), ['1980', '1990']);
    assert.ok(list.edition.includes('Alain Souchon'));
    assert.ok(list.edition.includes('AC-DC'));
    assert.ok(list.edition.includes('1990'), 'une édition « 1990 » utilise covers/1990.jpg');
  });

  it('trouve une image sans tenir compte de la casse ni des accents', () => {
    assert.equal(relative(images.resolve('language', 'french')), 'Language/French.jpg');
    assert.equal(relative(images.resolve('language', 'KOLSCH')), 'Language/Kölsch.jpg');
    assert.equal(relative(images.resolve('edition', 'alain souchon')), 'Alain Souchon.jpg');
    assert.equal(relative(images.resolve('edition', 'ac-dc')), 'AC-DC.PNG');
  });

  it('images des tags : dossier covers/tag, « _ » = espace', () => {
    assert.deepEqual(images.list().tag.sort(), ['disney', 'love song']);
    assert.equal(relative(images.resolve('tag', 'Love Song')), 'tag/love_song.jpg');
    assert.equal(relative(images.resolve('tag', 'DISNEY')), 'tag/disney.jpg');
    assert.equal(relative(images.resolve('tag', 'LOVE song')), 'tag/love_song.jpg');
    assert.equal(relative(images.resolve('tag', 'love_song')), 'tag/love_song.jpg');
    assert.equal(images.resolve('tag', 'love songs'), null);
  });

  it('gère les orthographes d’UltraStar (Finnish → Finish.jpg)', () => {
    assert.equal(relative(images.resolve('language', 'Finnish')), 'Language/Finish.jpg');
  });

  it('décennie : sous-dossier Decade prioritaire, racine en repli', () => {
    assert.equal(relative(images.resolve('decade', '1990')), 'Decade/1990.jpg');
    assert.equal(relative(images.resolve('decade', '1980')), '1980.jpg');
  });

  it('null pour une valeur, une facette inconnue ou une tentative de sortie du dossier', () => {
    assert.equal(images.resolve('language', 'Klingon'), null);
    assert.equal(images.resolve('genre', 'Pop'), null);
    assert.equal(images.resolve('edition', '../../secret'), null);
  });

  it('non configuré : listes vides, aucune image', async () => {
    const none = createFacetImages({ dir: null, logger: silentLogger });
    await none.load();
    assert.deepEqual(none.list(), { language: [], decade: [], edition: [], tag: [] });
    assert.equal(none.resolve('language', 'French'), null);
  });

  it('dossier inexistant : pas d’erreur, listes vides', async () => {
    const missing = createFacetImages({
      dir: path.join(covers.root, 'absent'),
      logger: silentLogger,
    });
    await missing.load();
    assert.deepEqual(missing.list(), { language: [], decade: [], edition: [], tag: [] });
  });
});
