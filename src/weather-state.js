// 天气 skill 的状态：调用限额、预警去重。
//
// 为什么单独一个文件而不是塞进 weather.js：weather.js 是**纯查询逻辑**（可独立测试），
// 而限额与去重是**跨进程持久状态**，而且写盘逻辑要能单独评审（涉及 cle（配额）保护）。
// 两者分开后，日限额逻辑即使写坏也不会影响天气查询本身。
import fs from 'node:fs';
import path from 'node:path';

const LIMIT_FILE = 'weather-usage.json';
const SEEN_FILE = 'weather-alerts.json';

function atomicWrite(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch { return fallback; }
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 日调用限额。
 *
 * 免额度数字无法通过 API 查到（和风不暴露配额接口），所以这里用**保守自限流**：
 * 即使实际免费额度更小也不至于打爆；而且 weather.js 有分类型缓存（实时 5 分钟、
 * 预报 30 分钟），正常聊天场景下一天几十次顶天了。
 *
 * @returns {{ allowed: boolean, used: number, limit: number, reason?: string }}
 */
export function checkQuota(stateDir, limit = 300, minGapMs = 1500) {
  const file = path.join(stateDir, LIMIT_FILE);
  const st = readJson(file, { day: '', used: 0, lastAt: 0 });
  const d = today();
  if (st.day !== d) { st.day = d; st.used = 0; }

  if (st.used >= limit) {
    return { allowed: false, used: st.used, limit, reason: `今天天气查询已达上限（${st.used}/${limit}），明天再查` };
  }
  const gap = Date.now() - Number(st.lastAt || 0);
  if (gap < minGapMs) {
    return { allowed: false, used: st.used, limit, reason: `查询太频繁（距上次 ${Math.round(gap / 1000)} 秒），稍等一下`, soft: true };
  }
  return { allowed: true, used: st.used, limit };
}

/** 记一次调用。 */
export function recordCall(stateDir) {
  const file = path.join(stateDir, LIMIT_FILE);
  const st = readJson(file, { day: '', used: 0, lastAt: 0 });
  const d = today();
  if (st.day !== d) { st.day = d; st.used = 0; }
  st.used += 1;
  st.lastAt = Date.now();
  try { atomicWrite(file, st); } catch { /* 记账失败不该阻断查询 */ }
  return st;
}

/** 当前用量（供 /a weather 状态展示）。 */
export function quotaStatus(stateDir, limit = 300) {
  const st = readJson(path.join(stateDir, LIMIT_FILE), { day: '', used: 0, lastAt: 0 });
  const d = today();
  return { day: d, used: st.day === d ? st.used : 0, limit };
}

/**
 * 预警去重：同一城市 + 同一预警 id + 同一发布时间只提醒一次。
 *
 * 为什么要去重：预警会持续几小时到几天，如果每次查天气都附一句"有暴雨预警"
 * 就会变成复读机。只在**第一次发现**时提示，之后静默。
 */
export function filterNewAlerts(stateDir, cityKey, warnings = []) {
  const file = path.join(stateDir, SEEN_FILE);
  const all = readJson(file, {});
  const seen = all[cityKey] ?? {};
  const fresh = [];
  const now = Date.now();
  for (const w of warnings) {
    const key = `${w.id ?? ''}|${w.pubTime ?? w.publishTime ?? ''}`;
    if (!key.trim() || key === '|') continue;
    if (seen[key]) continue;
    fresh.push(w);
    seen[key] = now;
  }
  // 只保留最近 200 条记录，避免文件无限增长
  const keys = Object.keys(seen);
  if (keys.length > 200) {
    keys.sort((a, b) => seen[a] - seen[b]);
    for (const k of keys.slice(0, keys.length - 200)) delete seen[k];
  }
  all[cityKey] = seen;
  try { atomicWrite(file, all); } catch { /* 去重失败最多多提醒一次，可接受 */ }
  return fresh;
}

/** 预警严重度排序（用于"只提醒较重的"）。 */
export const SEVERITY_RANK = { white: 0, blue: 1, yellow: 2, orange: 3, red: 4 };
export function severityOf(w) {
  const c = String(w?.severityColor ?? w?.severity ?? '').toLowerCase();
  const map = { white: 'white', blue: 'blue', yellow: 'yellow', orange: 'orange', red: 'red' };
  return map[c] ?? 'unknown';
}
