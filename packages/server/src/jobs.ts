import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Timeline } from '@reels/core';
import { config } from './config.js';
import { renderPoster, renderTimeline, type RenderResult } from './render.js';

/**
 * Очередь рендеров в памяти процесса.
 *
 * Сознательно простая: одна нода, без Redis. Этого хватает, пока виджетом
 * пользуется отдел продаж, а не весь интернет. Точка расширения обозначена —
 * заменить `enqueue`/`get` на обёртку над BullMQ можно не трогая роуты.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface Job {
  id: string;
  status: JobStatus;
  scenario: Timeline['scenario'];
  cardId: string;
  /** 0..1 */
  progress: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  result?: {
    /** Путь относительно адреса сервиса — его и использует виджет. */
    videoPath: string;
    posterPath: string;
    videoUrl: string;
    posterUrl: string;
    fileName: string;
    /** Человекочитаемое имя для сохранённого файла. */
    downloadName: string;
    bytes: number;
    frames: number;
    seconds: number;
    renderMs: number;
    assets: { total: number; failed: number };
    caption?: string;
    warnings: string[];
  };
}

interface QueueItem {
  job: Job;
  timeline: Timeline;
  stageUrl: string;
  controller: AbortController;
}

const jobs = new Map<string, Job>();
const queue: QueueItem[] = [];
let active = 0;

function safeName(timeline: Timeline): string {
  return `${timeline.cardId}-${timeline.scenario}-${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9._-]/g, '');
}

export function enqueue(timeline: Timeline, stageUrl: string): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    status: 'queued',
    scenario: timeline.scenario,
    cardId: timeline.cardId,
    progress: 0,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  queue.push({ job, timeline, stageUrl, controller: new AbortController() });
  queueMicrotask(pump);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(limit = 50): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function cancelJob(id: string): boolean {
  const index = queue.findIndex((item) => item.job.id === id);
  if (index >= 0) {
    const [item] = queue.splice(index, 1);
    if (item) {
      item.job.status = 'error';
      item.job.error = 'Отменено до начала рендера.';
      item.job.finishedAt = Date.now();
    }
    return true;
  }
  return false;
}

function pump(): void {
  while (active < config.render.concurrency && queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    active += 1;
    void run(item).finally(() => {
      active -= 1;
      queueMicrotask(pump);
    });
  }
}

async function run(item: QueueItem): Promise<void> {
  const { job, timeline, stageUrl } = item;
  job.status = 'running';
  job.startedAt = Date.now();

  const base = safeName(timeline);
  const videoPath = path.join(config.paths.output, `${base}.mp4`);
  const posterPath = path.join(config.paths.output, `${base}.jpg`);

  const timeout = setTimeout(() => item.controller.abort(), config.render.timeoutMs);

  try {
    const result: RenderResult = await renderTimeline({
      timeline,
      stageUrl,
      outPath: videoPath,
      signal: item.controller.signal,
      onProgress: (done, total) => {
        job.progress = done / total;
      },
    });

    await renderPoster({ timeline, stageUrl, outPath: posterPath }).catch(() => undefined);

    job.status = 'done';
    job.progress = 1;
    job.finishedAt = Date.now();
    job.result = {
      /**
       * Пути относительные, а не абсолютные.
       *
       * Раньше ссылка собиралась из PUBLIC_URL, и стоило его не
       * заполнить — она вела на `http://localhost:4000`, то есть
       * никуда. Превью при этом работало (оно ходит по адресу, с
       * которого загружено), и поломка вылезала только на кнопке
       * «Скачать». Виджет знает собственный адрес точно, поэтому
       * пусть он и подставляет его сам.
       */
      videoPath: `/files/${path.basename(videoPath)}`,
      posterPath: `/files/${path.basename(posterPath)}`,
      // Абсолютные адреса остаются для тех, кто зовёт API снаружи.
      videoUrl: `${config.publicUrl}/files/${path.basename(videoPath)}`,
      posterUrl: `${config.publicUrl}/files/${path.basename(posterPath)}`,
      fileName: path.basename(videoPath),
      downloadName: downloadName(timeline),
      bytes: result.bytes,
      frames: result.frames,
      seconds: Math.round((result.frames / timeline.fps) * 10) / 10,
      renderMs: result.durationMs,
      assets: result.assets,
      caption: timeline.caption,
      warnings: timeline.warnings,
    };
    void prune();
  } catch (err) {
    job.status = 'error';
    job.finishedAt = Date.now();
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }
}

/** Держит каталог вывода в рамках: самые старые файлы удаляются. */
async function prune(): Promise<void> {
  try {
    const dir = config.paths.output;
    const names = await fs.readdir(dir);
    if (names.length <= config.render.keepFiles) return;
    const stats = await Promise.all(
      names.map(async (name) => {
        const full = path.join(dir, name);
        const stat = await fs.stat(full);
        return { full, mtime: stat.mtimeMs };
      }),
    );
    stats.sort((a, b) => a.mtime - b.mtime);
    const excess = stats.slice(0, stats.length - config.render.keepFiles);
    await Promise.all(excess.map((f) => fs.rm(f.full, { force: true })));
  } catch {
    /* чистка — не критичный путь */
  }
}

export function queueStats(): { active: number; waiting: number } {
  return { active, waiting: queue.length };
}

/**
 * Имя, под которым ролик сохранится у менеджера.
 *
 * Внутреннее имя файла содержит хеш и метку времени — оно нужно, чтобы
 * файлы не перетирали друг друга, но в папке «Загрузки» такое имя
 * бесполезно. Здесь собирается читаемое: объект и сценарий.
 */
function downloadName(timeline: Timeline): string {
  const scenario: Record<string, string> = {
    'complex-overview': 'обзор ЖК',
    'lot-plan': 'лот с планировкой',
    promo: 'акция',
    progress: 'ход строительства',
  };
  const title = (timeline.caption ?? '').split('·')[0]?.trim() || timeline.cardId;
  const label = scenario[timeline.scenario] ?? timeline.scenario;
  return `${title} — ${label}.mp4`
    // Кавычки-ёлочки в имени файла читаются как мусор, а часть
    // символов запрещена в именах на Windows и macOS.
    .replace(/[«»"']/g, '')
    .replace(/[\\/:*?<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
