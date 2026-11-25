// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countMojibake, planMojibakeRepair, repairMojibake } from '../../src/parsers/mojibake.js';

/** Simule l'erreur : texte UTF-8 relu comme du Windows-1252. */
const garble = (/** @type {string} */ text) =>
  new TextDecoder('windows-1252').decode(Buffer.from(text, 'utf-8'));

describe('mojibake', () => {
  it('répare à, é, ’, œ, €, …', () => {
    const original = 'Un clair de lune à Maubeuge — l’été, œuvre à 5 € … ÀÉÇ';
    const garbled = garble(original);
    assert.notEqual(garbled, original);
    assert.deepEqual(repairMojibake(garbled), { text: original, count: 12 });
  });

  it('cas réel : « Ã » + espace insécable', () => {
    assert.equal(
      repairMojibake('Un clair de lune Ã  Maubeuge').text,
      'Un clair de lune à Maubeuge',
    );
  });

  it('texte double-encodé : plusieurs passes', () => {
    assert.equal(repairMojibake(garble(garble('été'))).text, 'été');
  });

  it('ne touche pas un texte correct', () => {
    for (const text of [
      'Été, à côté, l’œuvre « ici » — 5 €',
      'São Paulo, ÃO',
      'Ça, Â, ß',
      'à « ok »',
    ]) {
      assert.equal(countMojibake(text), 0, text);
      assert.equal(repairMojibake(text).text, text);
    }
  });

  it('conserve les fins de ligne et liste les lignes modifiées', () => {
    const text = `#TITLE:${garble('Été')}\r\n#ARTIST:Moi\r\n: 0 1 0 ${garble('déjà')}\r\nE\r\n`;
    const plan = planMojibakeRepair(text);
    assert.equal(plan.text, '#TITLE:Été\r\n#ARTIST:Moi\r\n: 0 1 0 déjà\r\nE\r\n');
    assert.equal(plan.count, 4);
    assert.deepEqual(
      plan.changes.map((c) => [c.line, c.after]),
      [
        [1, '#TITLE:Été'],
        [3, ': 0 1 0 déjà'],
      ],
    );
  });

  it('ignore ce qui suit la ligne de fin « E »', () => {
    const text = `#TITLE:${garble('Été')}\nE\n${garble('après')}`;
    assert.equal(repairMojibake(text).text, `#TITLE:Été\nE\n${garble('après')}`);
    assert.equal(countMojibake(`E\n${garble('été')}`), 0);
  });

  it('texte correct : aucun changement', () => {
    assert.deepEqual(planMojibakeRepair('#TITLE:Été\n'), {
      text: '#TITLE:Été\n',
      count: 0,
      changes: [],
    });
  });
});
