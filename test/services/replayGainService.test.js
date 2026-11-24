// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readReplayGain } from '../../src/services/replayGainService.js';

describe('readReplayGain', () => {
  it('fichier avec APEv2 + ID3v1, fichier sans tag, fichier absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'usm-rg-'));
    try {
      const value = '-3.70 dB';
      const head = Buffer.alloc(8);
      head.writeUInt32LE(value.length, 0);
      const items = Buffer.concat([
        head,
        Buffer.from('REPLAYGAIN_TRACK_GAIN\0'),
        Buffer.from(value),
      ]);
      const footer = Buffer.alloc(32);
      footer.write('APETAGEX', 0, 'latin1');
      footer.writeUInt32LE(items.length + 32, 12);
      const withTag = path.join(dir, 'a.mp3');
      await writeFile(
        withTag,
        Buffer.concat([
          Buffer.alloc(4000, 0xff),
          items,
          footer,
          Buffer.from('TAG'),
          Buffer.alloc(125),
        ]),
      );
      assert.equal((await readReplayGain(withTag))?.trackGain, -3.7);

      const plain = path.join(dir, 'b.mp3');
      await writeFile(plain, Buffer.alloc(4000, 0xff));
      assert.equal(await readReplayGain(plain), null);
      assert.equal(await readReplayGain(path.join(dir, 'absent.mp3')), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
