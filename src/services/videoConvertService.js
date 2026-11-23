// @ts-check
/**
 * Conversion d'une vidéo en MP4 H.264, à la demande, en tâche de fond (quelques minutes).
 *
 * Étapes, dans cet ordre pour ne jamais perdre de fichier :
 * 1. ffmpeg écrit dans un fichier temporaire caché du dossier chanson ;
 * 2. le résultat est relu : il doit être un MP4 H.264, sinon rien n'est changé ;
 * 3. sauvegarde datée de la vidéo d'origine dans BACKUP_DIR ;
 * 4. le fichier temporaire est renommé (écriture atomique) :
 *    - MP4 d'origine (ex. HEVC) : il remplace l'original, même nom ;
 *    - autre format (ex. clip.avi) : il devient clip.mp4, #VIDEO est mis à jour dans le .txt
 *      (avec sa propre sauvegarde), puis l'original est supprimé (sa copie est dans BACKUP_DIR).
 *
 * Une seule conversion à la fois (ffmpeg occupe tout le processeur), seule ou dans un lot
 * (corrections en masse : vidéos traitées l'une après l'autre, arrêt possible entre deux).
 *
 * @module services/videoConvertService
 */
import { access, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  isOversizedVideo,
  isRecommendedVideo,
  MP4_EXTENSIONS,
  needsConversion,
} from '../parsers/mp4Video.js';
import { resolveInside } from '../utils/safePath.js';
import { FfmpegError } from './ffmpegService.js';
import { backupFile } from './fileWriter.js';
import { SongEditError } from './songEditService.js';
import { probeVideoFile } from './videoProbe.js';

/** Écart toléré sur la date de modification du .txt, en ms. */
const MTIME_TOLERANCE_MS = 1;

/**
 * @typedef {object} VideoJob  Conversion en cours ou terminée (une par chanson, la dernière).
 * @property {string} songId
 * @property {'running' | 'done' | 'error'} state
 * @property {number | null} progress  0 à 1 (null si la durée est inconnue).
 * @property {string} from      Nom du fichier d'origine.
 * @property {string} to        Nom du fichier produit.
 * @property {boolean} replaces  Le fichier produit remplace l'original (même nom).
 * @property {number} startedAt
 * @property {number | null} finishedAt
 * @property {string | null} code     Code d'erreur (état « error »).
 * @property {string | null} backup   Sauvegarde de la vidéo d'origine (relative à BACKUP_DIR).
 */

/**
 * @typedef {import('./videoProbe.js').ProbedVideo & {
 *   duration: number | null, frameRate: number | null,
 *   recommended: boolean, oversized: boolean, isAudio: boolean, canConvert: boolean }} VideoDetails
 *   `recommended` : format MP4 H.264 ; `oversized` : plus grande que 1080p.
 *   `isAudio` : la vidéo sert aussi de fichier audio (jamais convertie, voir videoIsAudio).
 */

/**
 * @typedef {object} VideoCandidate  Vidéo à convertir (simulation en masse).
 * @property {string} id
 * @property {string | null} artist
 * @property {string | null} title
 * @property {string} file        « dossier/vidéo ».
 * @property {string} container
 * @property {string | null} codec
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} size  Taille en octets.
 * @property {boolean} isAudio  Sert aussi de fichier audio : listée mais jamais convertie.
 * @property {boolean} oversized  Plus grande que 1080p (sera réduite).
 * @property {number} modifiedAt   Date du .txt (contrôle « modifié entre-temps »).
 */

/**
 * @typedef {object} VideoBatchItem
 * @property {string} id
 * @property {string | null} artist
 * @property {string | null} title
 * @property {'pending' | 'running' | 'converted' | 'error' | 'skipped'} status
 * @property {number | null} progress
 * @property {string | null} code
 */

/**
 * @typedef {object} VideoBatch  Lot de conversions (un seul à la fois).
 * @property {'running' | 'done' | 'stopped'} state
 * @property {boolean} stopRequested
 * @property {number} startedAt
 * @property {number | null} finishedAt
 * @property {VideoBatchItem[]} items
 */

/**
 * @typedef {Omit<VideoBatch, 'items'> & {
 *   items: (VideoBatchItem & { expectedModifiedAt: number })[] }} InternalBatch
 *   Lot gardé en mémoire : chaque élément garde la date attendue du .txt (non renvoyée).
 */

/**
 * La vidéo sert aussi de fichier audio (#MP3 et #VIDEO désignent le même fichier) ?
 * Ces vidéos ne sont jamais converties : la conversion retire la bande son (UltraStar lit
 * normalement la musique dans le MP3), la chanson n'aurait plus de musique.
 *
 * @param {import('./catalogService.js').Song} song
 * @returns {boolean}
 */
export function videoIsAudio(song) {
  const { audio, video } = song.files;
  return Boolean(audio && video && audio.toLowerCase() === video.toLowerCase());
}

/** @param {string} file */
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * @param {object} options
 * @param {import('./catalogService.js').Catalog} options.catalog
 * @param {import('./songEditService.js').SongEditor} options.editor
 * @param {import('./ffmpegService.js').Ffmpeg} options.ffmpeg
 * @param {string} options.backupDir
 * @param {Pick<Console, 'info' | 'warn'>} [options.logger]
 */
export function createVideoConverter({ catalog, editor, ffmpeg, backupDir, logger = console }) {
  /** @type {Map<string, VideoJob>} */
  const jobs = new Map();
  /** Une conversion (seule ou en lot) occupe déjà ffmpeg. */
  let busy = false;
  /** Lot en cours ou dernier lot. @type {InternalBatch | null} */
  let batch = null;

  /**
   * Ce que ferait la conversion (aucun accès disque en écriture).
   * @param {import('./catalogService.js').Song} song
   */
  function planFor(song) {
    const folder = catalog.resolveSongFolder(song);
    const sourceName = song.files.video;
    const source = folder && sourceName ? resolveInside(folder, sourceName) : null;
    if (!folder || !sourceName || !source) {
      throw new SongEditError('VIDEO_NOT_FOUND', 'This song has no video file', 404);
    }
    if (!needsConversion(song.video)) {
      throw new SongEditError('VIDEO_ALREADY_H264', 'The video is already MP4 H.264, ≤ 1080p', 409);
    }
    if (videoIsAudio(song)) {
      throw new SongEditError(
        'VIDEO_IS_AUDIO',
        'The video file is also the audio file: converting it would remove the music',
        409,
      );
    }
    const { name, ext } = path.parse(sourceName);
    const replaces = MP4_EXTENSIONS.includes(ext.toLowerCase());
    const targetName = replaces ? sourceName : `${name}.mp4`;
    return {
      folder,
      source,
      sourceName,
      targetName,
      target: path.join(folder, targetName),
      replaces,
    };
  }

  /**
   * @param {import('./catalogService.js').Song} song
   * @param {number} expectedModifiedAt
   */
  async function checkUnchanged(song, expectedModifiedAt) {
    const file = catalog.resolveSongFile(song);
    const info = file ? await stat(file) : null;
    if (!info || Math.abs(info.mtimeMs - expectedModifiedAt) > MTIME_TOLERANCE_MS) {
      throw new SongEditError(
        'SONG_CHANGED',
        'The song file changed since it was displayed: refresh and try again',
        409,
      );
    }
  }

  /**
   * Déroulé de la conversion (tâche de fond : les erreurs sont reportées dans le job).
   * @param {import('./catalogService.js').Song} song
   * @param {ReturnType<typeof planFor>} plan
   * @param {VideoJob} job
   * @param {number} expectedModifiedAt
   */
  async function run(song, plan, job, expectedModifiedAt) {
    // Fichier caché : ignoré par le catalogue s'il traîne après une coupure.
    const temp = path.join(plan.folder, `.${path.parse(plan.targetName).name}.usm-converting.mp4`);
    try {
      const { duration } = await ffmpeg.probe(plan.source).catch(() => ({ duration: null }));
      job.progress = duration ? 0 : null;
      await ffmpeg.convertToH264({
        input: plan.source,
        output: temp,
        onProgress: (seconds) => {
          if (duration) job.progress = Math.min(0.99, seconds / duration);
        },
      });

      const check = await probeVideoFile(temp);
      if (check.codec !== 'h264') {
        throw new SongEditError('VIDEO_CONVERSION_FAILED', 'Converted file is not H.264', 500);
      }

      job.backup = await backupFile({
        file: plan.source,
        relativePath: `${song.folder}/${plan.sourceName}`,
        backupDir,
      });

      if (plan.replaces) {
        await rename(temp, plan.source);
      } else {
        if (await exists(plan.target)) {
          throw new SongEditError('VIDEO_TARGET_EXISTS', `${plan.targetName} already exists`, 409, {
            file: plan.targetName,
          });
        }
        await rename(temp, plan.target);
        try {
          await editor.setVideoFile(song.id, { video: plan.targetName, expectedModifiedAt });
        } catch (error) {
          await rm(plan.target, { force: true }); // le .txt n'a pas changé : on revient en arrière
          throw error;
        }
        await unlink(plan.source); // copie dans BACKUP_DIR (étape 3)
      }
      await catalog.refreshSong(song.id);
      logger.info(
        `Video converted ${song.folder}/${plan.sourceName} → ${plan.targetName} (backup: ${job.backup})`,
      );
      Object.assign(job, { state: 'done', progress: 1 });
    } catch (error) {
      const known = error instanceof SongEditError || error instanceof FfmpegError;
      if (!known) logger.warn(`Video conversion failed for ${song.folder}: ${error}`);
      Object.assign(job, { state: 'error', code: known ? error.code : 'VIDEO_CONVERSION_FAILED' });
    } finally {
      await rm(temp, { force: true });
      job.finishedAt = Date.now();
    }
  }

  /**
   * Vérifications communes avant une conversion (simulée ou réelle).
   * @param {string} id
   * @param {number} expectedModifiedAt
   */
  async function prepare(id, expectedModifiedAt) {
    const song = catalog.getSong(id);
    if (!song) throw new SongEditError('SONG_NOT_FOUND', 'Song not found', 404);
    const plan = planFor(song);
    if (!plan.replaces && (await exists(plan.target))) {
      throw new SongEditError('VIDEO_TARGET_EXISTS', `${plan.targetName} already exists`, 409, {
        file: plan.targetName,
      });
    }
    await checkUnchanged(song, expectedModifiedAt);
    const summary = { from: plan.sourceName, to: plan.targetName, replaces: plan.replaces };
    return { song, plan, summary };
  }

  async function ensureCanStart() {
    if (!(await ffmpeg.isAvailable())) {
      throw new SongEditError('FFMPEG_NOT_AVAILABLE', 'ffmpeg is not available', 503);
    }
    if (busy) throw new SongEditError('CONVERSION_BUSY', 'Another video is being converted', 409);
  }

  /**
   * @param {string} id
   * @param {{ from: string, to: string, replaces: boolean }} summary
   * @returns {VideoJob}
   */
  function newJob(id, summary) {
    /** @type {VideoJob} */
    const job = {
      songId: id,
      state: 'running',
      progress: null,
      ...summary,
      startedAt: Date.now(),
      finishedAt: null,
      code: null,
      backup: null,
    };
    jobs.set(id, job);
    return job;
  }

  /** @param {InternalBatch} target */
  function syncCurrentProgress(target) {
    const item = target.items.find((i) => i.status === 'running');
    if (item) item.progress = jobs.get(item.id)?.progress ?? null;
  }

  /**
   * @param {InternalBatch} source
   * @returns {VideoBatch}
   */
  const copyBatch = (source) => ({
    ...source,
    items: source.items.map(({ expectedModifiedAt: _ignored, ...item }) => ({ ...item })),
  });

  /**
   * Traite le lot vidéo après vidéo ; s'arrête proprement si l'arrêt est demandé.
   * @param {InternalBatch} target
   */
  async function runBatch(target) {
    for (const item of target.items) {
      if (target.stopRequested) {
        item.status = 'skipped';
        continue;
      }
      item.status = 'running';
      try {
        const { song, plan, summary } = await prepare(item.id, item.expectedModifiedAt);
        const job = newJob(item.id, summary);
        await run(song, plan, job, item.expectedModifiedAt);
        item.status = job.state === 'done' ? 'converted' : 'error';
        item.code = job.code;
        item.progress = job.state === 'done' ? 1 : null;
      } catch (error) {
        if (!(error instanceof SongEditError)) logger.warn(`Video batch: ${error}`);
        item.status = 'error';
        item.code = error instanceof SongEditError ? error.code : 'VIDEO_CONVERSION_FAILED';
      }
    }
    target.state = target.stopRequested ? 'stopped' : 'done';
    target.finishedAt = Date.now();
    const converted = target.items.filter((i) => i.status === 'converted').length;
    logger.info(`Video batch ${target.state}: ${converted}/${target.items.length} converted`);
  }

  return {
    /**
     * Description complète de la vidéo d'une chanson (fenêtre « info ») : l'analyse native
     * (MP4), complétée par ffprobe quand il est installé (autres formats, durée, images/s).
     *
     * @param {import('./catalogService.js').Song} song
     * @returns {Promise<VideoDetails | null>}
     */
    async describe(song) {
      const folder = catalog.resolveSongFolder(song);
      const file = folder && song.files.video ? resolveInside(folder, song.files.video) : null;
      if (!file || !song.video) return null;
      const available = await ffmpeg.isAvailable();
      const probed = available ? await ffmpeg.probe(file).catch(() => null) : null;
      const recommended = isRecommendedVideo(song.video);
      return {
        ...song.video,
        codec: song.video.codec ?? probed?.codec ?? null,
        width: song.video.width ?? probed?.width ?? null,
        height: song.video.height ?? probed?.height ?? null,
        duration: probed?.duration ?? null,
        frameRate: probed?.frameRate ?? null,
        recommended,
        oversized: isOversizedVideo(song.video),
        isAudio: videoIsAudio(song),
        canConvert: available && needsConversion(song.video) && !videoIsAudio(song),
      };
    },

    /**
     * Dernière conversion de cette chanson (en cours ou terminée), ou null.
     * @param {string} id
     * @returns {VideoJob | null}
     */
    getJob(id) {
      const job = jobs.get(id);
      return job ? { ...job } : null;
    },

    /**
     * Lance la conversion (ou la simule avec `dryRun`).
     *
     * @param {string} id
     * @param {{ expectedModifiedAt: number, dryRun?: boolean }} request
     * @returns {Promise<{ plan: { from: string, to: string, replaces: boolean }, job: VideoJob | null }>}
     * @throws {SongEditError}
     */
    async start(id, { expectedModifiedAt, dryRun = false }) {
      const { song, plan, summary } = await prepare(id, expectedModifiedAt);
      if (dryRun) return { plan: summary, job: null };
      await ensureCanStart();
      const job = newJob(id, summary);
      busy = true;
      run(song, plan, job, expectedModifiedAt).finally(() => {
        busy = false;
      });
      return { plan: summary, job: { ...job } };
    },

    /**
     * Vidéos à convertir (simulation des corrections en masse) : tout ce qui n'est pas en
     * MP4 H.264, avec la taille des fichiers (place nécessaire dans les sauvegardes).
     *
     * @returns {Promise<{ available: boolean, items: VideoCandidate[] }>}
     */
    async listCandidates() {
      const songs = catalog
        .getSongs()
        .filter((song) => song.files.video && needsConversion(song.video));
      const items = await Promise.all(
        songs.map(async (song) => {
          const folder = catalog.resolveSongFolder(song);
          const file = folder && song.files.video ? resolveInside(folder, song.files.video) : null;
          const size = file
            ? await stat(file).then(
                (s) => s.size,
                () => null,
              )
            : null;
          return {
            id: song.id,
            artist: song.artist,
            title: song.title,
            file: `${song.folder}/${song.files.video}`,
            container: song.video?.container ?? 'unknown',
            codec: song.video?.codec ?? null,
            width: song.video?.width ?? null,
            height: song.video?.height ?? null,
            size,
            isAudio: videoIsAudio(song),
            oversized: isOversizedVideo(song.video),
            modifiedAt: song.modifiedAt,
          };
        }),
      );
      return { available: await ffmpeg.isAvailable(), items };
    },

    /**
     * Lance un lot de conversions, traitées l'une après l'autre en tâche de fond.
     *
     * @param {{ id: string, expectedModifiedAt: number }[]} items
     * @returns {Promise<VideoBatch>}
     * @throws {SongEditError} FFMPEG_NOT_AVAILABLE, CONVERSION_BUSY
     */
    async startBatch(items) {
      await ensureCanStart();
      /** @type {InternalBatch} */
      const created = {
        state: 'running',
        stopRequested: false,
        startedAt: Date.now(),
        finishedAt: null,
        items: items.map(({ id, expectedModifiedAt }) => {
          const song = catalog.getSong(id);
          return {
            id,
            expectedModifiedAt,
            artist: song?.artist ?? null,
            title: song?.title ?? null,
            status: 'pending',
            progress: null,
            code: null,
          };
        }),
      };
      batch = created;
      busy = true;
      runBatch(created).finally(() => {
        busy = false;
      });
      return copyBatch(created);
    },

    /** @returns {VideoBatch | null} Lot en cours ou dernier lot terminé. */
    getBatch() {
      if (batch) syncCurrentProgress(batch);
      return batch ? copyBatch(batch) : null;
    },

    /**
     * Demande l'arrêt du lot après la vidéo en cours (jamais au milieu d'une conversion).
     * @returns {VideoBatch | null}
     */
    stopBatch() {
      if (batch?.state === 'running') batch.stopRequested = true;
      return batch ? copyBatch(batch) : null;
    },
  };
}

/** @typedef {ReturnType<typeof createVideoConverter>} VideoConverter */
