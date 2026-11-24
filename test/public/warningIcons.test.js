// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_WARNING_ICON, warningIcon } from '../../public/js/warningIcons.js';

describe('warningIcon', () => {
  it('donne une icône par type, précisée pour l’année et la langue', () => {
    assert.equal(warningIcon('*'), DEFAULT_WARNING_ICON);
    assert.equal(warningIcon('MISSING_HEADER:YEAR'), 'calendar3');
    assert.equal(warningIcon('MISSING_HEADER:LANGUAGE'), 'globe2');
    assert.equal(warningIcon('MISSING_HEADER:ARTIST'), 'file-earmark-minus');
    assert.equal(warningIcon('MISSING_FILE:video'), 'file-earmark-x');
    assert.equal(warningIcon('NAMING'), 'input-cursor-text');
    assert.equal(warningIcon('NAMING_COVER'), 'input-cursor-text');
    assert.equal(warningIcon('CODE_INCONNU'), DEFAULT_WARNING_ICON);
  });

  it('chaque icône utilisée existe dans le sprite', () => {
    const sprite = readFileSync(
      new URL('../../public/img/vendor/bootstrap-icons/icons.svg', import.meta.url),
      'utf8',
    );
    const types = [
      '*',
      'MISSING_HEADER:YEAR',
      'MISSING_HEADER:LANGUAGE',
      'MISSING_HEADER',
      'DUPLICATE_HEADER',
      'MALFORMED_HEADER',
      'UNKNOWN_LINE',
      'NO_NOTES',
      'MISSING_END',
      'ENCODING_NOT_UTF8',
      'ENCODING_UTF8_BOM',
      'MISSING_FILE',
      'VIDEO_NOT_H264',
      'VIDEO_TOO_LARGE',
      'VIDEO_IS_AUDIO',
      'REPLAYGAIN_MISSING',
      'NAMING',
    ];
    for (const type of types) {
      assert.ok(sprite.includes(`id="${warningIcon(type)}"`), `${type} → ${warningIcon(type)}`);
    }
  });
});
