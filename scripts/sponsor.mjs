#!/usr/bin/env node
// 赞助记账：把一笔赞助记进 state/sponsors.json（累计金额、最近备注、历史）。
//
// 用法:
//   node scripts/sponsor.mjs add <QQ> <金额> [备注...]
//   node scripts/sponsor.mjs list
//   node scripts/sponsor.mjs show <QQ>
//   node scripts/sponsor.mjs remove <QQ>            # 误记时删除
//
// 为什么要单独记账而不是塞进 config.json：config.json 是运行配置，额度变动频繁；
// 赞助是**人的账**，需要累积、可追溯、可单独备份。桥接只读它。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'state', 'sponsors.json');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j.sponsors || typeof j.sponsors !== 'object') j.sponsors = {};
    return j;
  } catch { return { sponsors: {} }; }
}
function save(j) {
  j.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
}
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => '¥' + Number(n).toFixed(2).replace(/\.00$/, '');

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const qq = String(rest[0] ?? '').trim();
  const amount = Number(rest[1]);
  const note = rest.slice(2).join(' ').trim();
  if (!/^\d{5,12}$/.test(qq)) { console.error('QQ 号无效：' + qq); process.exit(2); }
  if (!Number.isFinite(amount) || amount <= 0) { console.error('金额无效：' + rest[1]); process.exit(2); }
  const j = load();
  const cur = j.sponsors[qq] ?? { total: 0, currency: 'CNY', notes: [] };
  cur.total = Math.round((Number(cur.total || 0) + amount) * 100) / 100;
  cur.lastAmount = amount;
  if (note) cur.lastNote = note;
  cur.lastAt = today();
  cur.notes = Array.isArray(cur.notes) ? cur.notes : [];
  cur.notes.push({ amount, note, at: today() });
  if (cur.notes.length > 50) cur.notes = cur.notes.slice(-50); // 有界，长期可追
  j.sponsors[qq] = cur;
  save(j);
  console.log(`✅ 已记账: ${qq} 本次 ${money(amount)}${note ? `（${note}）` : ''} → 累计 ${money(cur.total)}`);
} else if (cmd === 'list') {
  const j = load();
  const rows = Object.entries(j.sponsors).sort((a, b) => Number(b[1].total) - Number(a[1].total));
  if (!rows.length) { console.log('还没有赞助记录。'); process.exit(0); }
  console.log('赞助榜（按累计金额）：');
  for (const [qq, s] of rows) {
    console.log(`  ${qq.padEnd(12)} ${money(s.total).padStart(8)}   ${s.notes?.length ?? 0} 笔   最近: ${s.lastNote ?? '（无备注）'}（${s.lastAt ?? '?'}）`);
  }
} else if (cmd === 'show') {
  const j = load();
  const s = j.sponsors[String(rest[0] ?? '').trim()];
  console.log(s ? JSON.stringify(s, null, 2) : '该 QQ 没有赞助记录。');
} else if (cmd === 'remove') {
  const qq = String(rest[0] ?? '').trim();
  const j = load();
  if (!j.sponsors[qq]) { console.log('该 QQ 没有记录。'); process.exit(0); }
  delete j.sponsors[qq];
  save(j);
  console.log('已删除 ' + qq);
} else {
  console.log('用法:');
  console.log('  node scripts/sponsor.mjs add <QQ> <金额> [备注...]');
  console.log('  node scripts/sponsor.mjs list');
  console.log('  node scripts/sponsor.mjs show <QQ>');
  console.log('  node scripts/sponsor.mjs remove <QQ>');
  process.exit(cmd ? 2 : 0);
}
