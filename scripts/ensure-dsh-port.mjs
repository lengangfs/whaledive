// DSH 端口自动发现（在 guard.cmd 启动桥接前跑一次）
//
// 背景：DSH 桌面版每次启动都自己选一个监听端口（命令行没有 --port，也不写任何
// 运行时文件）。桥接的 config.dsh.baseUrl 是静态的，于是 DSH 一换端口桥接就完全
// 失联 —— 2026-10-19 ~ 10-26 八天内发生了 6 次，每次都要人工改配置再重启桥接。
//
// 本脚本在每次桥接启动前跑：
//   ① 先探配置里的地址，活着就直接退出（零开销）；
//   ② 否则找到 DeepSeek Harness 进程，读它自己监听的端口（精确，不会认错成
//      控制台面板 3210 或 relay 5099 —— 那两个也回 401，靠端口扫会误判）；
//   ③ 更新 config.json 并记日志。
//
// 退出码恒为 0：这是辅助步骤，失败也不能挡住桥接启动（桥接自己会重试）。

import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = 'D:/DSHWork/qq-bridge/';
const CFG = B + 'config.json';
const log = (m) => console.log('[dsh-discover] ' + m);

function probe(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

/** 该端口是不是 DSH：HTTP 服务存活（401 也算，说明服务在但需鉴权）。 */
async function isDsh(port) {
  if (!(await probe(port))) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    return r.status === 401 || r.ok;
  } catch { return false; }
}

/** 从 DSH 进程反查它监听的端口 —— 这是唯一不会认错的识别方式。 */
/**
 * 从 DSH 进程反查它监听的端口 —— 唯一不会认错的识别方式。
 *
 * 为什么不用 PowerShell：`powershell -Command <多行脚本>` 会剥掉内层引号，字符串
 * 字面量被当成命令执行（实测踩过）。tasklist / netstat 是纯文本表格，在 Node 里
 * 解析反而更稳，也不依赖 PowerShell 的编码/引号规则。
 */
function dshPortsFromProcess() {
  const { execFileSync } = require('node:child_process');

  // ① DSH 的 PID 列表
  let tlist = '';
  try {
    tlist = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000 });
  } catch { return []; }
  const pids = new Set();
  for (const line of tlist.split('\n')) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && /DeepSeek Harness\.exe/i.test(m[1])) pids.add(Number(m[2]));
  }
  if (!pids.size) return [];

  // ② PID → 监听端口
  let nstat = '';
  try { nstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 15000 }); }
  catch { return []; }

  const ports = new Set();
  for (const line of nstat.split('\n')) {
    //   TCP    127.0.0.1:58781    0.0.0.0:0    LISTENING    18232
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (pids.has(pid) && port > 1024 && port < 65536) ports.add(port);
  }
  return [...ports];
}

// （createRequire 已在文件顶部导入）

async function main() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch (e) { log('读不到 config.json，跳过：' + e.message); return; }

  const cur = String(cfg.dsh?.baseUrl ?? '');
  const curPort = Number((/:(\d+)$/.exec(cur) ?? [])[1] ?? 0);

  // ① 配置地址还活着就不动
  if (curPort && (await isDsh(curPort))) {
    return; // 静默返回，正常路径不产生噪音
  }

  // ② 从 DSH 进程反查端口
  let ports = [];
  try { ports = dshPortsFromProcess(); }
  catch (e) { log('查询 DSH 进程失败：' + e.message); return; }
  if (!ports.length) { log('没找到运行中的 DSH 进程，保持原配置'); return; }

  for (const p of ports) {
    if (!(await isDsh(p))) continue;
    const next = 'http://127.0.0.1:' + p;
    if (next === cur) return;
    try {
      fs.writeFileSync(CFG + '.bak-dshport-' + new Date().toISOString().replace(/[:.]/g, '-'), fs.readFileSync(CFG));
      cfg.dsh.baseUrl = next;
      fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      log(`DSH 端口漂移已自动修正：${cur} → ${next}`);
    } catch (e) { log('写入 config.json 失败：' + e.message); }
    return;
  }
  log('DSH 进程在跑但没有可用的 HTTP 端口，保持原配置');
}

await main();
process.exit(0);
