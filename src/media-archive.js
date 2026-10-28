// 入站媒体归档：把群里的图片 / 语音 / 文件落盘，避免 URL 过期后永久丢失。
//
// 为什么需要（2026-10-14 实测）：
//   桥接原先**只存带 rkey 的 URL，不存字节**。而那个 URL 是有寿命的：
//     10/08 18:06 的图片 URL → HTTP 400（已失效）
//     10/14 22:35 的图片（刚发的）→ HTTP 200
//   也就是说**过一天，群里的图就永久取不回来了**。最近窗口 1073 条消息里图片占 15.7%。
//   语音更糟：它们甚至没有 url 落到 media 里（extractMediaFromSegments 原先不认 record 段），
//   事后只能拿 message_id 去 get_msg 重新捞 —— 而 get_msg 也只能救回还没过期的那部分。
//
// 两个来源，两种取法：
//   · image / file —— 直接用 safeFetchBuffer 下 URL（带 SSRF 防护、DNS 固定、大小上限）
//   · record       —— **不能直接下 URL**：QQ 语音实际是腾讯私有的 SILK_V3，
//                     文件后缀写着 .amr 是骗人的，ffmpeg 标准版解不了。
//                     必须让网关转码：POST /get_record { file, out_format:'mp3' }，
//                     音频在响应的 **data.base64** 里（不是 data.file，那还是原始 CDN 地址）。
//
// 设计约束：
//   · **绝不阻塞消息处理**：出问题只记日志，不抛。
//   · **绝不重复下**：同名文件存在就跳过（file 字段本身是内容哈希，天然去重）。
//   · **有上限**：单文件、当日总量、保留天数都可配；超了跳过并记一次日志，不静默。

import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBuffer } from './safe-fetch.js';

/** 会归档的媒体类型。face（表情）不归档：它只是 faceId，没有字节。 */
export const ARCHIVABLE_KINDS = new Set(['image', 'record', 'file']);

const DEFAULTS = {
  enabled: true,
  retainDays: 30,
  maxFileMB: 20,
  maxTotalMB: 2048,
  recordFormat: 'mp3'
};

export function mediaConfig(root) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))?.media ?? {};
  } catch { /* 配置读不到就用默认；归档不该因为配置问题把桥接拖下水 */ }
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: file.enabled !== false,
    retainDays: Math.max(0, n(file.retainDays, DEFAULTS.retainDays)),
    maxFileMB: Math.max(1, n(file.maxFileMB, DEFAULTS.maxFileMB)),
    maxTotalMB: Math.max(16, n(file.maxTotalMB, DEFAULTS.maxTotalMB)),
    recordFormat: String(file.recordFormat ?? DEFAULTS.recordFormat)
  };
}

export function mediaRoot(root) {
  return path.join(root, 'state', 'media');
}

function indexFile(root) {
  return path.join(mediaRoot(root), 'index.jsonl');
}

/** 把 QQ 给的 file 名清成一个安全的纯文件名（它可能带路径或怪字符）。 */
function safeName(kind, file, url) {
  let base = String(file ?? '').trim();
  if (base) {
    base = path.basename(base.replace(/\\/g, '/'));
    base = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120);
  }
  if (!base) {
    // 没有 file 字段时用 url 的 fileid 兜底，保证同一张图每次得到同一个名字（可去重）。
    const m = /[?&]fileid=([\w-]+)/.exec(String(url ?? ''));
    base = (m ? m[1] : String(Date.now())) .slice(0, 80);
  }
  if (!path.extname(base)) {
    base += kind === 'record' ? '.mp3' : (kind === 'image' ? '.jpg' : '.bin');
  }
  return base;
}

function dayDir(root, at) {
  const d = new Date(at || Date.now());
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(mediaRoot(root), name);
}

function appendIndex(root, rec) {
  try {
    const dir = mediaRoot(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(indexFile(root), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 索引写不进去不影响已落盘的文件 */ }
}

/** 当前归档总量（MB）。用于总量告警与报表，遍历一次目录即可，量级很小。 */
export function archiveUsage(root) {
  const base = mediaRoot(root);
  let bytes = 0, files = 0;
  const walk = (p) => {
    let es;
    try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else { files++; try { bytes += fs.statSync(f).size; } catch { /* ignore */ } }
    }
  };
  walk(base);
  return { files, mb: Math.round(bytes / 1024 / 1024 * 10) / 10 };
}

/** 归档总量（字节）。淘汰逻辑要精确值，不能用四舍五入后的 MB。 */
export function archiveUsageBytes(root) {
  let bytes = 0;
  const walk = (p) => {
    let es;
    try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else { try { bytes += fs.statSync(f).size; } catch { /* ignore */ } }
    }
  };
  walk(mediaRoot(root));
  return bytes;
}

/**
 * 按"最旧优先"淘汰，给新文件腾地方。
 *
 * 为什么必须是「删旧」而不是「拒新」（2026-10-21 修正，用户指出）：
 * 归档的意义是**留住最近的**。原来的实现到达上限就跳过新文件 ——
 * 等于为了保住 30 天前的图而放弃今天的图，方向完全反了。
 *
 * 与 retainDays 的分工：
 *   · retainDays   = 过期清理（按天数），保证不会无限保留；
 *   · 本函数       = 容量清理（按总量），保证新的一直存得下。
 *
 * 淘汰到 90% 就停，避免"每分钟都触发一次淘汰"（每次只腾一点点会导致每张图都删一堆）。
 */
export function ensureRoom(root, needBytes, cfg, log) {
  const capBytes = Math.max(16, cfg.maxTotalMB) * 1024 * 1024;
  let usage = archiveUsageBytes(root);
  if (usage + needBytes <= capBytes) return { evicted: 0, freedBytes: 0 };

  const base = mediaRoot(root);
  const dayDirs = [];
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)) dayDirs.push(e.name);
    }
  } catch { return { evicted: 0, freedBytes: 0 }; }
  dayDirs.sort();   // YYYY-MM-DD 字典序即时间序，最旧在前

  const target = Math.floor(capBytes * 0.9);
  let evicted = 0, freedBytes = 0;
  outer: for (const day of dayDirs) {
    const dir = path.join(base, day);
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      if (usage + needBytes <= target) break outer;
      if (name === 'index.jsonl' || name.endsWith('.part')) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        fs.unlinkSync(path.join(dir, name));
        usage -= st.size; freedBytes += st.size; evicted++;
      } catch { /* 单文件失败不致命，继续淘汰下一个 */ }
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
  }
  if (evicted) {
    log(`媒体归档：为写入新文件，按最旧优先淘汰 ${evicted} 个（释放 ${(freedBytes / 1048576).toFixed(1)}MB）`);
  }
  return { evicted, freedBytes };
}

/**
 * 归档一批媒体。**永不出错**（只记日志），因为它挂在消息处理路径上。
 *
 * @returns {Promise<{saved:number, skipped:number, failed:number}>}
 */
export async function archiveMediaBatch({ root, key, sender, seq, at, media, httpUrl, token, log = () => {} }) {
  const cfg = mediaConfig(root);
  const res = { saved: 0, skipped: 0, failed: 0 };
  if (!cfg.enabled) return res;

  const maxFileBytes = cfg.maxFileMB * 1024 * 1024;
  // 注意：这里**不再**"超上限就整体跳过"。
  // 容量满时改为删最旧腾地方（见 ensureRoom），归档的语义是留住最近的，
  // 不能为了保全旧文件而让新文件丢失。

  const base = String(httpUrl || '').replace(/\/+$/, '');
  const dir = dayDir(root, at);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  for (const m of Array.isArray(media) ? media : []) {
    if (!m || !ARCHIVABLE_KINDS.has(m.kind)) continue;
    const name = safeName(m.kind, m.file, m.url);
    const dst = path.join(dir, name);
    if (fs.existsSync(dst)) { res.skipped++; continue; }   // 同名 = 同内容，跳过

    try {
      let buf = null;
      let note = '';

      if (m.kind === 'record') {
        // 语音：让网关转码，音频在 data.base64 里。
        const r = await fetch(`${base}/get_record`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ file: m.file, out_format: cfg.recordFormat }),
          signal: AbortSignal.timeout(30000)
        });
        const j = await r.json().catch(() => ({}));
        const b64 = j?.data?.base64;
        if (!b64) throw new Error(`get_record 没返回 base64（retcode=${j?.retcode} ${j?.wording ?? ''}）`);
        const b = Buffer.from(b64, 'base64');
        // 转码产物一律存成 recordFormat 后缀，别信原来的 .amr
        buf = b;
        note = `转码为 ${cfg.recordFormat}`;
      } else {
        if (!m.url) { res.skipped++; continue; }
        const b = await safeFetchBuffer(m.url, maxFileBytes);
        buf = b.buffer ?? b;
      }

      if (!buf || !buf.length) { res.skipped++; continue; }
      if (buf.length > maxFileBytes) {
        log(`媒体归档：${name} 超过单文件上限 ${cfg.maxFileMB}MB（${Math.round(buf.length / 1024 / 1024)}MB），跳过`);
        res.skipped++;
        continue;
      }

      // 写盘前先确保有空间：容量满时按最旧优先淘汰，而不是丢掉这张新图。
      ensureRoom(root, buf.length, cfg, log);

      const finalName = name.replace(/\.[^.]+$/, '') + (m.kind === 'record' ? `.${cfg.recordFormat}` : path.extname(name));
      const finalPath = path.join(dir, finalName);
      if (fs.existsSync(finalPath)) { res.skipped++; continue; }
      // 先写临时文件再改名：中途失败不会留下看起来完整的半截文件。
      const tmp = finalPath + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, finalPath);

      appendIndex(root, {
        at: at || Date.now(),
        key, sender: sender ?? '', seq: seq ?? null,
        kind: m.kind,
        file: m.file ?? '', url: m.url ?? '',
        path: path.relative(root, finalPath).replace(/\\/g, '/'),
        bytes: buf.length,
        note
      });
      res.saved++;
    } catch (error) {
      res.failed++;
      log(`媒体归档失败（${key} ${m.kind} ${name}）：${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  return res;
}

/** 按保留天数清理。返回删掉的文件数与释放的 MB。 */
export function pruneMediaArchive(root, log = () => {}) {
  const cfg = mediaConfig(root);
  const res = { removedFiles: 0, freedMB: 0, removedDirs: 0 };
  if (!cfg.enabled || cfg.retainDays <= 0) return res;
  const base = mediaRoot(root);
  if (!fs.existsSync(base)) return res;

  const cutoff = Date.now() - cfg.retainDays * 86400000;
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
    const dayMs = Date.parse(e.name + 'T23:59:59+08:00');
    if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue;
    const dir = path.join(base, e.name);
    let bytes = 0, n = 0;
    const walk = (p) => {
      for (const x of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, x.name);
        if (x.isDirectory()) walk(f);
        else { try { bytes += fs.statSync(f).size; } catch { /* ignore */ } n++; fs.unlinkSync(f); }
      }
    };
    try { walk(dir); fs.rmdirSync(dir); } catch { /* ignore */ }
    res.removedFiles += n;
    res.removedDirs++;
    res.freedMB += bytes / 1024 / 1024;
  }
  res.freedMB = Math.round(res.freedMB * 10) / 10;
  if (res.removedFiles) log(`媒体归档：按 ${cfg.retainDays} 天保留清理，删除 ${res.removedFiles} 个文件（${res.freedMB}MB）`);
  return res;
}
