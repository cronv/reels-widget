/**
 * Сквозная проверка: фид → карточка → таймлайн → MP4.
 *
 * Запуск: npm run build && npm run smoke
 * Сервер поднимается сам, на порту из SMOKE_PORT (по умолчанию 4311),
 * рендерит все четыре сценария и печатает отчёт.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 4311);
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const log = (...args) => console.log(...args);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
};

async function waitForServer(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Сервер не поднялся за отведённое время.');
}

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${route} вернул не JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${route} → ${res.status}: ${json.error ?? text.slice(0, 200)}`);
  return json;
}

/** Подставляет локальные картинки вместо внешних ссылок из примера фида. */
function withLocalAssets(card) {
  const asset = (name) => `${BASE}/examples/assets/${name}`;
  return {
    ...card,
    complex: {
      ...card.complex,
      highlights: ['Школа во дворе', 'Паркинг на 420 мест', 'Своя набережная', 'Двор без машин'],
      escrow: true,
    },
    promo: {
      title: 'Скидка 7% на последние лоты',
      subtitle: 'Только в этом корпусе',
      discountPercent: 7,
      until: new Date(Date.now() + 9 * 86_400_000).toISOString(),
    },
    contact: { phone: '+7 495 120-45-45', site: 'severstroy.ru' },
    media: [
      { kind: 'render', url: asset('render-1.jpg') },
      { kind: 'render', url: asset('render-2.jpg') },
      { kind: 'render', url: asset('render-3.jpg') },
      { kind: 'plan', url: asset('plan-1.jpg') },
      { kind: 'progress', url: asset('progress-1.jpg'), caption: 'Август 2026 — монолит 14 этажа' },
      { kind: 'progress', url: asset('progress-2.jpg'), caption: 'Сентябрь 2026 — фасадные работы' },
      { kind: 'progress', url: asset('progress-3.jpg'), caption: 'Октябрь 2026 — остекление' },
    ],
  };
}

async function pollJob(id, label) {
  const started = Date.now();
  let lastShown = -1;
  for (;;) {
    const { job } = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(`${label}: ${job.error}`);
    const pct = Math.round(job.progress * 100);
    if (pct >= lastShown + 20) {
      log(`    ${label}: ${pct}%`);
      lastShown = pct;
    }
    if (Date.now() - started > 300_000) throw new Error(`${label}: таймаут рендера`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function main() {
  log('→ Поднимаю сервер…');
  const server = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_URL: BASE,
      OUTPUT_DIR: path.join(ROOT, '.output'),
      RENDER_CONCURRENCY: process.env.RENDER_CONCURRENCY ?? '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`  [srv] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`  [srv] ${d}`));

  try {
    await waitForServer();
    log('  сервер готов\n');

    // ── 1. Фид ───────────────────────────────────────────────────────────
    log('→ Разбираю пример фида');
    const xml = await fs.readFile(path.join(ROOT, 'examples/feed.sample.xml'), 'utf8');
    const feed = await post('/api/extract/feed', { payload: xml });
    log(`  формат ${feed.format}, объектов ${feed.total}`);
    for (const w of feed.warnings) log(`  ⚠ ${w}`);
    if (feed.cards.length !== 2) fail(`ожидалось 2 карточки, пришло ${feed.cards.length}`);

    const card = withLocalAssets(feed.cards[0]);
    log(`  карточка: ${card.complex.name}, ${card.lot.areaTotal} м², ${card.price.value} ₽\n`);

    // ── 2. Доступность сценариев ─────────────────────────────────────────
    log('→ Проверяю доступность сценариев');
    const { scenarios } = await post('/api/timeline/available', { card });
    for (const s of scenarios) {
      log(`  ${s.available ? '✓' : '×'} ${s.title} (${s.seconds}с)${s.missing.length ? ' — нет: ' + s.missing.join(', ') : ''}`);
    }
    log('');

    // ── 3. Таймлайны ─────────────────────────────────────────────────────
    log('→ Собираю таймлайны');
    const targets = scenarios.filter((s) => s.available && (!ONLY.length || ONLY.includes(s.id)));
    for (const s of targets) {
      const { timeline } = await post('/api/timeline', { card, scenario: s.id });
      const secs = timeline.durationInFrames / timeline.fps;
      const layers = timeline.scenes.reduce((n, sc) => n + sc.layers.length, 0);
      log(`  ${s.id.padEnd(17)} ${secs.toFixed(1)}с · сцен ${timeline.scenes.length} · слоёв ${layers}`);
      if (secs !== s.seconds) fail(`${s.id}: ${secs}с вместо ${s.seconds}с`);
    }
    log('');

    // ── 4. Рендер ────────────────────────────────────────────────────────
    log('→ Рендерю MP4');
    const jobs = [];
    for (const s of targets) {
      const { job } = await post('/api/render', { card, scenario: s.id });
      jobs.push({ id: job.id, label: s.id });
    }
    const results = await Promise.all(jobs.map((j) => pollJob(j.id, j.label)));
    log('');

    log('→ Результат');
    for (const job of results) {
      const r = job.result;
      const mb = (r.bytes / 1024 / 1024).toFixed(2);
      const speed = (r.renderMs / 1000).toFixed(1);
      log(`  ${job.scenario.padEnd(17)} ${r.seconds}с · ${r.frames} кадров · ${mb} МБ · ${speed}с рендера`);
      if (r.assets.failed) fail(`${job.scenario}: не загрузилось картинок — ${r.assets.failed}`);
      if (r.bytes < 20_000) fail(`${job.scenario}: подозрительно маленький файл (${r.bytes} Б)`);
      for (const w of r.warnings) log(`    ⚠ ${w}`);
    }

    // ── 5. Проверка файлов ───────────────────────────────────────────────
    log('\n→ Проверяю файлы через ffprobe');
    for (const job of results) {
      const file = path.join(ROOT, '.output', job.result.fileName);
      const probe = await probeVideo(file);
      const ok =
        probe.width === 1080 &&
        probe.height === 1920 &&
        Math.abs(probe.duration - job.result.seconds) < 0.35;
      log(
        `  ${ok ? '✓' : '✗'} ${job.scenario.padEnd(17)} ${probe.width}×${probe.height} · ` +
          `${probe.duration.toFixed(2)}с · ${probe.codec} · fps ${probe.fps}`,
      );
      if (!ok) fail(`${job.scenario}: параметры файла не совпали с ожидаемыми`);
    }

    log(`\n${process.exitCode ? '✗ Есть проблемы' : '✓ Сквозной прогон прошёл'}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    server.kill('SIGKILL');
  }
}

function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,r_frame_rate:format=duration',
      '-of', 'json',
      file,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe упал'));
      const json = JSON.parse(out);
      const s = json.streams[0];
      const [num, den] = s.r_frame_rate.split('/').map(Number);
      resolve({
        width: s.width,
        height: s.height,
        codec: s.codec_name,
        fps: Math.round(num / den),
        duration: Number(json.format.duration),
      });
    });
  });
}

main().catch((err) => {
  console.error('\n✗', err.message);
  process.exit(1);
});
