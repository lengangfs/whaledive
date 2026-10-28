// 她的日记：补上"长期情景记忆"。
//
// 为什么需要（2026-10-14 的现状）：
//   她记得住**人** —— memberImpressions 22 条，永久，内容具体；
//   但记不住**日子** —— activeTopics 24 小时被清掉、pendingThoughts 2 小时过期。
//   于是"上周你说你去考试了"这类跨天的事，她无从谈起。
//
// 设计取舍：
//   · **她自己写**，不由程序从日志里拼 —— 这不是一份统计报表，是她的第一人称记忆。
//     程序只负责：到点提醒她、给她一份"今天发生了什么"的素材、把结果存好。
//   · 一天一个 .md 文件，人可读、可 grep、可直接拿给你看。
//   · 写入走**显式工具**（qq_diary_write），不猜她的文本输出 —— 猜错了会存进垃圾。
//   · 注入有上限：只回灌最近 N 天、每天截断，避免日记越长提示词越肥（这正是角色卡
//     注入踩过的坑：内容越大 → 压缩越早 → 反而被挤掉）。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  enabled: true,
  hour: 23,
  minute: 30,
  injectDays: 3,
  maxCharsPerEntry: 400,
  maxCharsPerWrite: 1200,
  chatKey: ''
};

export function diaryConfig(root) {
  let file = {};
  let ownerQQ = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    file = cfg?.diary ?? {};
    ownerQQ = String(cfg?.ownerQQ ?? '');
  } catch { /* 配置读不到就用默认，日记不该把桥接拖下水 */ }
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: file.enabled !== false,
    hour: Math.min(23, Math.max(0, n(file.hour, DEFAULTS.hour))),
    minute: Math.min(59, Math.max(0, n(file.minute, DEFAULTS.minute))),
    injectDays: Math.max(0, Math.min(14, n(file.injectDays, DEFAULTS.injectDays))),
    maxCharsPerEntry: Math.max(80, n(file.maxCharsPerEntry, DEFAULTS.maxCharsPerEntry)),
    maxCharsPerWrite: Math.max(200, n(file.maxCharsPerWrite, DEFAULTS.maxCharsPerWrite)),
    // 提醒投递到哪个会话。默认主人私聊 —— 那是她最可能被回应、也最不会打扰群的地方。
    chatKey: String(file.chatKey || (ownerQQ ? `private:${ownerQQ}` : ''))
  };
}

export function diaryDir(root) {
  return path.join(root, 'state', 'diary');
}

/** 本地日期（Asia/Shanghai 语义）：日记按"她过的这一天"分，不按 UTC。 */
export function diaryDateKey(at = Date.now()) {
  const d = new Date(at);
  const off = 8 * 60; // 固定 +08:00，与机器时区无关，避免跨时区/夏令时把日记切错天
  const local = new Date(d.getTime() + (off + d.getTimezoneOffset()) * 60000);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
}

function fileFor(root, dateKey) {
  return path.join(diaryDir(root), `${dateKey}.md`);
}

/** 写一条日记。同一天重复写 = 覆盖（她重写一遍就该覆盖，不该堆两份）。 */
export function writeDiary(root, text, meta = {}) {
  const cfg = diaryConfig(root);
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  const clipped = body.length > cfg.maxCharsPerWrite
    ? body.slice(0, cfg.maxCharsPerWrite) + '…'
    : body;

  const dateKey = diaryDateKey(meta.at ?? Date.now());
  // ⚠️ 必须在写之前判存在：写成之后 readDiary 当然读得到，overwritten 就恒为 true（自己踩过）。
  const existed = readDiary(root, dateKey) !== null;
  try {
    fs.mkdirSync(diaryDir(root), { recursive: true });
    const header = `# ${dateKey}\n\n`;
    fs.writeFileSync(fileFor(root, dateKey), header + clipped + '\n', 'utf8');
    return { ok: true, dateKey, chars: clipped.length, overwritten: existed };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 读某一天（默认今天）。返回纯文本（不含 # 标题行）。 */
export function readDiary(root, dateKey) {
  const key = dateKey || diaryDateKey();
  const p = fileFor(root, key);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw.replace(/^#\s*\d{4}-\d{2}-\d{2}\s*\n+/, '').trim();
  } catch { return null; }
}

/** 列出已有的日记日期（新→旧）。 */
export function listDiary(root) {
  const d = diaryDir(root);
  if (!fs.existsSync(d)) return [];
  try {
    return fs.readdirSync(d)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort()
      .reverse();
  } catch { return []; }
}

/**
 * 最近 N 天，按时间正序返回 [{dateKey, text}]。给提示词注入用。
 * 今天的日记通常还没写（要到晚上才写），所以自然只回灌"过去几天"。
 */
export function recentDiary(root, days) {
  const cfg = diaryConfig(root);
  const n = Math.max(0, days ?? cfg.injectDays);
  if (n <= 0) return [];
  const all = listDiary(root).slice(0, n + 1); // +1：今天可能已经写了
  const out = [];
  for (const k of all.reverse()) {
    const text = readDiary(root, k);
    if (!text) continue;
    out.push({
      dateKey: k,
      text: text.length > cfg.maxCharsPerEntry ? text.slice(0, cfg.maxCharsPerEntry) + '…' : text
    });
  }
  return out.slice(-n);
}

/** 给唤醒提示词用的文本块。没日记就返回空串（不产生空标题）。 */
export function diaryBlock(root, days) {
  const items = recentDiary(root, days);
  if (!items.length) return '';
  const lines = items.map((x) => `- ${x.dateKey}：${x.text.replace(/\s*\n\s*/g, ' ')}`);
  return `【你最近记下的日子】\n${lines.join('\n')}`;
}
