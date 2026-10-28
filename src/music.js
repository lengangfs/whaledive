// 网易云音乐检索（非官方接口，2026-10-26 实测可用）
//
// 用途：让安酱在别人推荐歌曲时能"查一下再说"——按歌名/歌手搜到 id、拿到歌词和
// 基本信息，这样她可以聊这首歌，而不是只会转发一个 id。
//
// 为什么用非官方接口：网易云的官方开放平台需要申请、且不返回搜索结果；这三个
// 网页端接口（cloudsearch / song/detail / song/lyric）不需要登录、不需要 cookie，
// 只要求带浏览器 UA 和 Referer（不带 Referer 会被 403）。
//
// 已知局限：
//   · 版权原因，某些原版歌曲搜不到，结果里混着大量翻唱/钢琴版 —— 这是网易云的
//     数据问题，接口无法区分"原唱"。调用方应把前几条都列出来让人自己选。
//   · 接口随时可能变，失败要能优雅降级（抛错由调用方转成文字回复）。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://music.163.com/',
  'Accept': 'application/json'
};
const TIMEOUT = 12000;

/** 搜索结果里的单条，字段已压平成"她好读、好复述"的形态。 */
function pickSong(s) {
  const id = String(s?.id ?? '');
  return {
    id,
    name: String(s?.name ?? ''),
    artists: (s?.ar ?? s?.artists ?? []).map((a) => a?.name).filter(Boolean).join('/'),
    album: String(s?.al?.name ?? s?.album?.name ?? ''),
    durationSec: Math.round(Number(s?.dt ?? s?.duration ?? 0) / 1000),
    link: id ? `https://music.163.com/song?id=${id}` : ''
  };
}

/** 按关键词搜歌。query 可以是歌名、歌手、或"歌名 歌手"。 */
export async function searchMusic(query, limit = 6) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const n = Math.min(20, Math.max(1, Number(limit) || 6));
  const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(q)}&type=1&limit=${n}&offset=0`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`网易云搜索 HTTP ${res.status}`);
  const j = await res.json().catch(() => null);
  const songs = j?.result?.songs ?? [];
  return songs.map(pickSong).filter((s) => s.id && s.name);
}

/** 把 LRC 歌词转成人读的纯文本：去掉 [mm:ss.xxx] 时间轴，保留作词/作曲信息。 */
function lrcToPlain(lrc) {
  return String(lrc ?? '')
    .split('\n')
    .map((line) => line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim())
    .filter((line, i, arr) => line || (arr[i - 1] && arr[i - 1] !== '')) // 连续空行压成一行
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 歌曲详情 + 歌词。歌词默认截断，避免把整首歌灌进上下文。 */
export async function getMusicInfo(id, { maxLyricChars = 1800 } = {}) {
  const songId = String(id ?? '').trim();
  if (!/^\d+$/.test(songId)) throw new Error('歌曲 id 必须是纯数字');

  const [detRes, lyrRes] = await Promise.all([
    fetch(`https://music.163.com/api/song/detail?ids=%5B${songId}%5D`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) }),
    fetch(`https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) })
  ]);

  const det = detRes.ok ? await detRes.json().catch(() => null) : null;
  const lyr = lyrRes.ok ? await lyrRes.json().catch(() => null) : null;
  const s = det?.songs?.[0];
  if (!s) return null;

  const rawLyric = lyr?.lrc?.lyric ?? '';
  const plain = lrcToPlain(rawLyric);
  const truncated = plain.length > maxLyricChars;

  return {
    id: songId,
    name: String(s.name ?? ''),
    artists: (s.artists ?? []).map((a) => a?.name).filter(Boolean).join('/'),
    album: String(s.album?.name ?? ''),
    durationSec: Math.round(Number(s.duration ?? 0) / 1000),
    releaseDate: String(s.album?.publishTime ?? ''),
    link: `https://music.163.com/song?id=${songId}`,
    hasLyric: !!plain,
    lyric: truncated ? plain.slice(0, maxLyricChars) + '…' : plain,
    lyricTruncated: truncated
  };
}

/** 格式化时长：秒 → "4:29"。 */
export function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
