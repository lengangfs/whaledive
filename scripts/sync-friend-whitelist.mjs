// 把 QQ 好友列表同步成 qq-bridge 的私聊白名单。
// 用途：加了好友就放行其私聊，不必手改 config.json。
// 用法: node sync-friend-whitelist.mjs [--dry] [--quiet]
//   --quiet 只写 state/whitelist-sync.log，不输出到 stdout（计划任务用，避免任何窗口）
// 需要：SnowLuma 在跑（OneBot HTTP API 可达）、桥接在跑（控制台在听）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const QUIET = process.argv.includes('--quiet');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = String(cfg.snowluma?.accessToken ?? '');
const consolePort = Number(cfg.consolePort) || 3100;
const BOT = Number(cfg.selfQQ ?? 0); // 通常未知；下面用登录信息动态取

// 计划任务跑的时候 stdout 没人接管，所以同时落一份日志便于事后核对。
// 只保留最近 500 行，避免无限增长。
const LOG_FILE = path.join(ROOT, 'state', 'whitelist-sync.log');
const stamp = () => new Date().toLocaleString('zh-CN');
const appendLog = (m) => {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${stamp()}] ${m}\n`, 'utf8');
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    if (lines.length > 520) fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n'), 'utf8');
  } catch { /* 日志失败不影响同步 */ }
};
const log = (m) => { if (!QUIET) console.log(m); appendLog(m); };
const die = (m) => { console.error('❌ ' + m); appendLog('❌ ' + m); process.exit(1); };

// 1) 取登录账号（用于排除机器人自己）
let selfId = 0;
try {
  const r = await fetch(`${httpUrl}/get_login_info`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const j = await r.json();
  if (j?.status === 'ok' || j?.retcode === 0) selfId = Number(j.data?.user_id ?? 0);
} catch (e) { die(`连不上 OneBot HTTP API（${httpUrl}）：${e.message}`); }
if (!selfId) die('拿不到登录账号（get_login_info 失败）；SnowLuma 是否已登录 QQ？');

// 2) 取好友列表
let friends = [];
try {
  const r = await fetch(`${httpUrl}/get_friend_list`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const j = await r.json();
  friends = (j?.data ?? []).map((f) => Number(f.user_id)).filter((n) => Number.isFinite(n) && n > 0);
} catch (e) { die(`取好友列表失败：${e.message}`); }
if (!friends.length) die('好友列表为空，拒绝把白名单清成空');

const next = [...new Set(friends.filter((id) => id !== selfId))].sort((a, b) => a - b);
// owner 必须永远在私聊白名单里：好友列表里没有他（被删好友/临时异常）时也不能同步掉，
// 否则 owner 私聊会被 fail-closed 拦掉，管理员反而失联。
const ownerQQ = Number(cfg.ownerQQ ?? 0);
if (ownerQQ > 0 && !next.includes(ownerQQ)) {
  next.push(ownerQQ);
  next.sort((a, b) => a - b);
  log(`⚠️ owner ${ownerQQ} 不在好友列表里，已强制保留在私聊白名单`);
}
const cur = (cfg.allow?.private ?? []).map(Number);
const added = next.filter((id) => !cur.includes(id));
const removed = cur.filter((id) => !next.includes(id));

log(`登录账号: ${selfId}（已排除）`);
log(`好友总数: ${friends.length} → 写入白名单: ${next.length}`);
if (added.length) log(`新增 ${added.length} 个: ${added.join(', ')}`);
if (removed.length) log(`移除 ${removed.length} 个（已不是好友）: ${removed.join(', ')}`);
if (!added.length && !removed.length) { log('白名单已是最新，无需改动。'); process.exit(0); }
if (DRY) { log('（--dry 模式，未写入）'); process.exit(0); }

// 3) 通过控制台接口写入（不传 deny/ownerQQ，桥接会保留现值）
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const body = { allow: { private: next, groups: cfg.allow?.groups ?? [] } };
const res = await fetch(`http://127.0.0.1:${consolePort}/api/whitelist`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
  body: JSON.stringify(body)
});
const out = await res.json();
if (!out?.ok) die(`写入失败：${JSON.stringify(out)}`);
log(`✅ 白名单已更新：私聊 ${out.allow.private.length} 个，群 ${(out.allow.groups ?? []).join(',') || '无'}，管理员 ${out.ownerQQ}`);
