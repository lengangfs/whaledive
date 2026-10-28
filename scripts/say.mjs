// 让安酱"开口说话"：把文本用 TTS 合成语音，落进 qq-bridge 的语音库（audio/）。
//
// 用法:
//   node say.mjs "你好呀，我是安酱"                     # 用 config.json 里的默认音色与语速合成
//   node say.mjs "在吗" --voice bella                  # 换音色
//   node say.mjs "在吗" --speed 0.85                    # 临时改语速（默认取 config.json）
//   node say.mjs "测试" --out D:\tmp\test.mp3          # 指定输出路径（不进语音库）
//   node say.mjs --list-voices                         # 列出可用系统预置音色
//
// 默认音色/语速**与桥接同源**（读 config.json 的 socialV2.voiceTts），避免手动合成与
// AI 自动发出的声线不一致。
// 依赖：SiliconFlow 的 API key —— 必须通过环境变量 SILICONFLOW_API_KEY 或 QQ_BRIDGE_TTS_KEY 提供。
// 设计：合成失败一律以非 0 退出并打印真实错误，绝不静默产出一个空文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = path.join(ROOT, 'audio');

const MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
// 系统预置音色（官方文档）：男声 alex/benjamin/charles/david，女声 anna/bella/claire/diana
const VOICES = {
  alex: '沉稳男声', benjamin: '低沉男声', charles: '磁性男声', david: '欢快男声',
  anna: '沉稳女声', bella: '激情女声', claire: '温柔女声', diana: '欢快女声'
};

// 默认音色/语速**从 config.json 的 socialV2.voiceTts 读取**，与桥接（qq_send_voice 的 text 路径）
// 保持同一个声线。硬编码会在两处漂移：手动合成是 anna、AI 发出的却是 claire，听起来像两个人。
function ttsDefaultsFromConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const t = c?.socialV2?.voiceTts ?? {};
    return {
      voice: String(t.voice ?? 'claire').replace(/^.*:/, ''),
      speed: Number(t.speed ?? 1),
      gain: Number(t.gain ?? 0),
      baseUrl: String(t.baseUrl ?? 'https://api.siliconflow.cn/v1')
    };
  } catch {
    return { voice: 'claire', speed: 1, gain: 0, baseUrl: 'https://api.siliconflow.cn/v1' };
  }
}
const CFG = ttsDefaultsFromConfig();
const DEFAULT_VOICE = VOICES[CFG.voice] ? CFG.voice : 'claire';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);

if (has('--list-voices')) {
  console.log('可用系统预置音色：');
  for (const [k, v] of Object.entries(VOICES)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log(`\n默认: ${DEFAULT_VOICE}（语速 ${CFG.speed}，读自 config.json）  用法: node say.mjs "要说的话" --voice bella`);
  process.exit(0);
}

const text = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--voice' && argv[argv.indexOf(a) - 1] !== '--out');
if (!text) {
  console.error('用法: node say.mjs "要说的话" [--voice 音色] [--out 路径]');
  console.error('      node say.mjs --list-voices');
  process.exit(2);
}

const voiceName = String(flag('--voice') ?? DEFAULT_VOICE).replace(/^.*:/, '');
if (!VOICES[voiceName]) {
  console.error(`未知音色「${voiceName}」。可用：${Object.keys(VOICES).join(', ')}`);
  process.exit(2);
}

const KEY = process.env.SILICONFLOW_API_KEY || process.env.QQ_BRIDGE_TTS_KEY || '';
const baseUrl = String(flag('--base-url') ?? CFG.baseUrl).replace(/\/+$/, '');
// 语速/增益与桥接同源（config.json），也可用 --speed / --gain 临时覆盖
const speed = Number(flag('--speed') ?? CFG.speed);
const gain = Number(flag('--gain') ?? CFG.gain);

// 输出位置：默认进语音库（AI 能用 qq_send_voice 发出去），文件名带时间戳避免覆盖
let out = flag('--out');
if (!out) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  out = path.join(AUDIO_DIR, `say-${voiceName}-${stamp}.mp3`);
}

// 官方提示：输入内容不要加空格。中文里有意保留的空格会破坏韵律，这里做一次规整。
const cleanText = String(text).replace(/\s+/g, '');
if (!cleanText) { console.error('文本为空。'); process.exit(2); }

console.log(`音色 : ${voiceName}（${VOICES[voiceName]}）  语速 ${speed}`);
console.log(`文本 : ${cleanText}（${Buffer.byteLength(cleanText, 'utf8')} 字节）`);
console.log(`输出 : ${out}`);

let res;
try {
  res = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      voice: `${MODEL}:${voiceName}`,
      input: cleanText,
      response_format: 'mp3',
      // 只在非默认值时下发，避免给不需要的模型塞未知参数
      ...(Number.isFinite(speed) && speed !== 1 ? { speed } : {}),
      ...(Number.isFinite(gain) && gain !== 0 ? { gain } : {})
    }),
    signal: AbortSignal.timeout(90000)
  });
} catch (e) {
  console.error(`❌ 请求失败：${e.message}`);
  process.exit(1);
}

const buf = Buffer.from(await res.arrayBuffer());
if (!res.ok) {
  console.error(`❌ TTS 返回 HTTP ${res.status}：${buf.toString('utf8').slice(0, 300)}`);
  process.exit(1);
}
// 音频一定比 JSON 错误大得多；过小的一律当失败，避免把错误当音频存进语音库。
if (buf.length < 2000) {
  console.error(`❌ 返回内容过小（${buf.length} 字节），疑似不是音频：${buf.toString('utf8').slice(0, 200)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log(`✅ 已生成 ${(buf.length / 1024).toFixed(1)} KB`);
if (!flag('--out')) console.log(`   AI 现在可以用文件名「${path.basename(out)}」通过 qq_send_voice 发出去（先用 qq_list_voices 确认）。`);
