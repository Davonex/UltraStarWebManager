// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildConvertArgs,
  createFfmpeg,
  ffprobePathFor,
  parseProbeOutput,
  parseProgress,
  SCALE_FILTER,
} from '../../src/services/ffmpegService.js';
import { probeVideoFile } from '../../src/services/videoProbe.js';

const silentLogger = { info() {}, warn() {} };

describe('ffprobePathFor', () => {
  it('ffprobe dans le même dossier que ffmpeg', () => {
    assert.equal(ffprobePathFor('ffmpeg'), 'ffprobe');
    assert.equal(ffprobePathFor('/opt/ffmpeg/bin/ffmpeg'), path.join('/opt/ffmpeg/bin', 'ffprobe'));
    assert.equal(ffprobePathFor('/opt/FFmpeg.exe'), path.join('/opt', 'ffprobe.exe'));
  });
});

describe('buildConvertArgs', () => {
  const args = buildConvertArgs('in.avi', 'out.mp4');
  /** @param {string} flag */
  const argOf = (flag) => args[args.indexOf(flag) + 1];

  it('H.264 High, sans audio, faststart, images clés toutes les 2 s', () => {
    assert.equal(argOf('-c:v'), 'libx264');
    assert.equal(argOf('-profile:v'), 'high');
    assert.equal(argOf('-pix_fmt'), 'yuv420p');
    assert.equal(argOf('-movflags'), '+faststart');
    assert.equal(argOf('-force_key_frames'), 'expr:gte(t,n_forced*2)');
    assert.ok(args.includes('-an'));
  });

  it('résolution : gardée, réduite à 1080p au-delà, entrée et sortie à leur place', () => {
    assert.equal(argOf('-vf'), SCALE_FILTER);
    assert.match(SCALE_FILTER, /min\(1920,iw\).*min\(1080,ih\).*decrease.*force_divisible_by=2/);
    assert.equal(argOf('-i'), 'in.avi');
    assert.equal(args.at(-1), 'out.mp4');
  });
});

describe('parseProgress / parseProbeOutput', () => {
  it('dernière position annoncée par -progress', () => {
    assert.equal(
      parseProgress('frame=10\nout_time_us=1500000\nout_time_us=2500000\nprogress=continue\n'),
      2.5,
    );
    assert.equal(parseProgress('frame=1\n'), null);
  });

  it('codec, résolution, durée et images/s depuis le JSON de ffprobe', () => {
    const json = JSON.stringify({
      streams: [{ codec_name: 'mpeg4', width: 720, height: 576, avg_frame_rate: '25/1' }],
      format: { duration: '215.48' },
    });
    assert.deepEqual(parseProbeOutput(json), {
      codec: 'mpeg4',
      width: 720,
      height: 576,
      duration: 215.48,
      frameRate: 25,
    });
    assert.deepEqual(parseProbeOutput('{}'), {
      codec: null,
      width: null,
      height: null,
      duration: null,
      frameRate: null,
    });
  });
});

describe('createFfmpeg', () => {
  it('programme absent : indisponible, sans exception', async () => {
    const ffmpeg = createFfmpeg({ ffmpegPath: '/chemin/inexistant/ffmpeg', logger: silentLogger });
    assert.equal(await ffmpeg.isAvailable(), false);
  });

  // Test réel, seulement si ffmpeg est installé sur la machine qui lance les tests.
  let installed = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch {
    installed = false;
  }
  it('convertit une vidéo MPEG-4 (AVI, 322×240) en MP4 H.264 de même résolution', {
    skip: !installed,
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'usm-ffmpeg-'));
    try {
      const input = path.join(dir, 'clip.avi');
      const output = path.join(dir, 'clip.mp4');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=322x240:rate=25:duration=3',
        '-c:v',
        'mpeg4',
        input,
      ]);
      const ffmpeg = createFfmpeg({ ffmpegPath: 'ffmpeg', logger: silentLogger });
      assert.equal(await ffmpeg.isAvailable(), true);
      assert.deepEqual(
        { ...(await ffmpeg.probe(input)), duration: null },
        { codec: 'mpeg4', width: 322, height: 240, duration: null, frameRate: 25 },
      );
      /** @type {number[]} */
      const progress = [];
      await ffmpeg.convertToH264({ input, output, onProgress: (s) => progress.push(s) });
      assert.deepEqual(
        { ...(await probeVideoFile(output)), modifiedAt: null },
        {
          container: 'mp4',
          codec: 'h264',
          width: 322,
          height: 240,
          modifiedAt: null,
        },
      );
      assert.ok(progress.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('réduit une vidéo plus grande que 1080p en gardant ses proportions', {
    skip: !installed,
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'usm-ffmpeg-'));
    try {
      const ffmpeg = createFfmpeg({ ffmpegPath: 'ffmpeg', logger: silentLogger });
      /** @type {[string, number[]][]} */
      const cases = [
        ['2560x1440', [1920, 1080]], // 16:9 → 1080p
        ['2400x1800', [1440, 1080]], // 4:3 : limité par la hauteur
        ['1280x720', [1280, 720]], // inchangée
      ];
      for (const [size, expected] of cases) {
        const input = path.join(dir, `${size}.mkv`);
        const output = path.join(dir, `${size}.mp4`);
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `testsrc=size=${size}:rate=25:duration=1`,
          '-c:v',
          'mpeg4',
          input,
        ]);
        await ffmpeg.convertToH264({ input, output });
        const { width, height } = await probeVideoFile(output);
        assert.deepEqual([width, height], expected, size);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
