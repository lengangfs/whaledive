// qq-bridge 状态日志修剪：只截断"只追加"的日志文件，按行数保留最近 N 行。
//
// 设计取舍：
//  - 只在超过阈值时才重写，避免每天无谓改动文件；
//  - 不碰 config.json / social-v2.json / sessions.json（这些是状态，不是日志）；
//  - 不碰 state/token-usage.jsonl（你的费用账本，要留着看趋势）；
//  - 桥接对这些日志是 appendFileSync，截断后它继续往新文件追加，不会打架；
//    但为稳妥，建议在没人说话时跑（也就是安酱 02:00-07:00 睡觉那段）。
//
// 用法: node prune-state-logs.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const STATE = path.join(ROOT, 'state');

// 每个文件：超过 minBytes 就保留最后 keepLines 行
const TARGETS = [
  { file: 'bridge.log', keepLines: 3000, minBytes: 512 * 1024 },
  { file: 'qq-activity.log', keepLines: 2000, minBytes: 256 * 1024 },
  { file: 'tool-calls.jsonl', keepLines: 5000, minBytes: 2 * 1024 * 1024 }
];

// SnowLuma 的日志：按文件大小修剪（它自己每天一个文件，不删文件只截断过大的）
const SNOWLUMA_LOGS = 'D:\\SnowLuma-v1.14.22-win-x64\\logs';
const SNOWLUMA_KEEP_LINES = 20000;
const SNOWLUMA_MIN_BYTES = 8 * 1024 * 1024;

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
let touched = 0;

function pruneByLines(file, keepLines, minBytes) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.size < minBytes) return { file, size: st.size, action: 'skip（未超阈值）' };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines.length <= keepLines) return { file, size: st.size, action: 'skip（行数已达标）' };
  const kept = lines.slice(-keepLines).join('\n');
  if (!DRY) {
    const tmp = file + '.prune-tmp';
    fs.writeFileSync(tmp, kept, 'utf8');
    fs.renameSync(tmp, file); // 先写临时文件再原子替换：读到一半不会看到半个文件
  }
  touched++;
  return { file, size: st.size, action: `修剪 ${lines.length} -> ${keepLines} 行`, after: Buffer.byteLength(kept) };
}

console.log(`qq-bridge 状态日志修剪${DRY ? '（--dry 空跑）' : ''}`);
console.log('--- state/（只追加的日志）---');
for (const t of TARGETS) {
  const r = pruneByLines(path.join(STATE, t.file), t.keepLines, t.minBytes);
  if (!r) { console.log(`  ${t.file.padEnd(20)} 不存在，跳过`); continue; }
  const after = r.after !== undefined ? ` -> ${kb(r.after)}` : '';
  console.log(`  ${t.file.padEnd(20)} ${kb(r.size).padStart(10)}  ${r.action}${after}`);
}

console.log('--- SnowLuma 日志 ---');
try {
  const files = fs.readdirSync(SNOWLUMA_LOGS).filter((f) => f.endsWith('.log'));
  if (!files.length) console.log('  没有 .log 文件');
  for (const f of files) {
    const r = pruneByLines(path.join(SNOWLUMA_LOGS, f), SNOWLUMA_KEEP_LINES, SNOWLUMA_MIN_BYTES);
    if (!r) continue;
    const after = r.after !== undefined ? ` -> ${kb(r.after)}` : '';
    console.log(`  ${f.padEnd(20)} ${kb(r.size).padStart(10)}  ${r.action}${after}`);
  }
} catch (e) {
  console.log(`  读取失败（SnowLuma 未安装或被移动？）：${e.message}`);
}

console.log('');
// ── 入站媒体归档的保留清理（2026-10-14 加）──────────────────────────────────
// 与上面的"按大小裁剪日志"不是一回事：这里按**保留天数**删整个日期目录。
// 保留策略在 config.json 的 media.retainDays（默认 30 天），脚本不自己定数字。
console.log('--- 媒体归档（state/media）---');
try {
  const { pruneMediaArchive, archiveUsage } = await import('../src/media-archive.js');
  const before = archiveUsage(ROOT);
  console.log(`  当前 ${before.files} 个文件 / ${before.mb} MB`);
  if (DRY) {
    console.log('  --dry：跳过实际清理');
  } else {
    const r = pruneMediaArchive(ROOT, (m) => console.log('  ' + m));
    const after = archiveUsage(ROOT);
    if (r.removedFiles) {
      console.log(`  按保留天数删除 ${r.removedFiles} 个文件（${r.freedMB} MB），剩 ${after.files} 个 / ${after.mb} MB`);
      touched += r.removedFiles;
    } else {
      console.log('  没有超过保留天数的文件');
    }
  }
} catch (e) {
  console.log(`  跳过（媒体归档模块不可用）：${e.message}`);
}

console.log('');
console.log(touched ? `完成：修剪了 ${touched} 个文件。` : '完成：所有文件都在阈值内，无需修剪。');
console.log('未触碰：token-usage.jsonl（费用账本）、social-v2.json / sessions.json（运行状态）、config.json。');
