// 和风天气客户端：给桥接的管理命令与 AI 工具共用。
//
// 设计取舍：
//  1) **输出中文自然语言**，不返回 JSON —— AI 拿到 JSON 容易照抄字段名念数据，
//     变成"temp 20 humidity 92"这种不像人说的话。这里直接拼成一句话。
//  2) **城市名 → location id 单独缓存 24h**：城市 ID 是静态映射，没必要每次查。
//  3) **每类数据独立 TTL**：实时天气 5 分钟、预报 30 分钟、预警 3 分钟（预警最要紧）。
//  4) 出错不抛给调用方，返回 { ok:false, error }，让上层决定怎么措辞（AI 需要知道"查不到"
//     才能老实说不知道，而不是编一个天气）。
import fs from 'node:fs';
import path from 'node:path';
import { checkQuota, recordCall, quotaStatus, filterNewAlerts, SEVERITY_RANK, severityOf } from './weather-state.js';

const DEFAULT_HOST = 'ph4nmu7xvj.re.qweatherapi.com';
const DEFAULT_KEY = 'd25b67e9ec204e2ab873ad942eae5905';

const cityCache = new Map(); // 城市名 -> { id, name, adm1, adm2, lat, lon, ts }
const dataCache = new Map(); // 缓存键 -> { data, ts }
const CITY_TTL = 24 * 3600 * 1000;

const TTL = {
  now: 5 * 60 * 1000,
  d3: 30 * 60 * 1000,
  d7: 30 * 60 * 1000,
  h24: 15 * 60 * 1000,
  warning: 3 * 60 * 1000,
  indices: 60 * 60 * 1000,
  air: 30 * 60 * 1000,
  astro: 12 * 3600 * 1000
};

/** 从 config.json 读配置（host/key），缺省用兜底值。 */
function readConfig(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const w = cfg.weather ?? {};
    return {
      host: String(w.host || DEFAULT_HOST).trim(),
      key: String(w.key || DEFAULT_KEY).trim(),
      defaultCity: String(w.defaultCity || '').trim(),
      timeoutMs: Number(w.timeoutMs) || 15000,
      quotaPerDay: Number(w.quotaPerDay) || 300,
      minGapMs: Number(w.minGapMs) || 1500,
      alertEnabled: w.alert?.enabled !== false,
      alertMinSeverity: String(w.alert?.minSeverity || 'yellow')
    };
  } catch {
    return {
      host: DEFAULT_HOST, key: DEFAULT_KEY, defaultCity: '', timeoutMs: 15000,
      quotaPerDay: 300, minGapMs: 1500, alertEnabled: true, alertMinSeverity: 'yellow'
    };
  }
}

async function getJson(cfg, apiPath) {
  const url = `https://${cfg.host}${apiPath}${apiPath.includes('?') ? '&' : '?'}key=${cfg.key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok || (j && j.code && j.code !== '200')) {
    const detail = j?.error?.detail ?? j?.error?.title ?? text.slice(0, 120);
    throw new Error(`和风天气 HTTP ${r.status}: ${detail}`);
  }
  return j;
}

/** 城市名 → location。支持直接传 location id（纯数字）。 */
async function resolveCity(cfg, input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('需要城市名');
  if (/^\d{6,12}$/.test(raw)) return { id: raw, name: raw, adm1: '', adm2: '' };

  const hit = cityCache.get(raw);
  if (hit && Date.now() - hit.ts < CITY_TTL) return hit;

  const j = await getJson(cfg, `/geo/v2/city/lookup?location=${encodeURIComponent(raw)}&number=1`);
  const loc = j?.location?.[0];
  if (!loc) throw new Error(`找不到城市：${raw}`);

  // 和风的城市搜索是**模糊匹配**：输入乱码（如"不存在的城市xyz123"）会返回一个
  // 毫无关系的城市（实测返回了日本"安城市"）。这比查不到更糟——AI 会拿着错误城市
  // 的天气当真话说出去。所以这里做一次合理性校验：匹配名必须与输入有共同字符。
  const name = String(loc.name ?? '');
  const common = [...raw].some((ch) => /[\u4e00-\u9fa5A-Za-z]/.test(ch) && name.includes(ch));
  if (!common) throw new Error(`找不到城市「${raw}」（和风返回的「${name}」与输入不匹配，可能是模糊匹配误命中）`);

  const rec = {
    id: loc.id, name, adm1: loc.adm1 ?? '', adm2: loc.adm2 ?? '',
    lat: loc.lat, lon: loc.lon, country: loc.country ?? '', ts: Date.now()
  };
  cityCache.set(raw, rec);
  return rec;
}

/** 带 TTL 的取数。 */
async function cached(key, ttl, fn) {
  const hit = dataCache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const data = await fn();
  dataCache.set(key, { data, ts: Date.now() });
  return data;
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/**
 * 顺手发现预警（不额外增加"查天气"的账）。
 *
 * 用户要的行为：**在用 skill 时顺便发现预警再推送**，而不是后台轮询。
 * 所以这里只在 now/forecast 被调用时看一眼预警（预警自身有 3 分钟缓存，
 * 短时间内多次查天气不会重复打接口），并且：
 *   - 只有**新预警**（同 id+发布时间没提醒过）才返回
 *   - 只有等级 ≥ minSeverity（默认 yellow）才返回，避免白色/蓝色预警刷屏
 *   - 任何异常都吞掉，绝不影响天气本身的回答
 */
async function maybeAlert(cfg, city, where, stateDir) {
  try {
    if (cfg.alertEnabled === false) return null;
    const j = await cached(`warn:${city.id}`, TTL.warning, () => getJson(cfg, `/v7/warning/now?location=${city.id}`));
    const list = j.warning ?? [];
    if (!list.length) return null;
    const min = SEVERITY_RANK[String(cfg.alertMinSeverity || 'yellow')] ?? 2;
    const fresh = filterNewAlerts(stateDir, city.id, list)
      .filter((w) => (SEVERITY_RANK[severityOf(w)] ?? 9) >= min);
    if (!fresh.length) return null;
    const top = fresh.sort((a, b) => (SEVERITY_RANK[severityOf(b)] ?? 0) - (SEVERITY_RANK[severityOf(a)] ?? 0))[0];
    const color = { white: '白色', blue: '蓝色', yellow: '黄色', orange: '橙色', red: '红色' }[severityOf(top)] ?? '';
    return {
      text: `${where}${top.title ?? '天气预警'}${color ? `（${color}）` : ''}：${String(top.text ?? '').slice(0, 140)}`,
      count: fresh.length,
      severity: severityOf(top)
    };
  } catch { return null; }
}


/**
 * 拼显示名（直辖市 vs 普通地级市）。
 *
 * 实测数据：上海 → name="上海" adm1="上海市"；杭州 → name="杭州" adm1="浙江省"。
 * 直接 `${adm1}${name}` 会拼出"上海市上海"（直辖市重复）。规则：
 *   ① 省级名包含城市名（直辖市：上海市 ⊇ 上海，北京市 ⊇ 北京）→ 只用省级名
 *   ② 否则用"省+市"以区分同名城市（吉林省吉林市 等）
 */
function displayName(city) {
  const name = String(city.name ?? '');
  const prov = String(city.adm1 ?? '');
  if (!prov || prov === name) return name;
  if (prov.includes(name)) return prov;
  return prov + name;
}


const fmtDay = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} ${wd}`;
};

/**
 * 天气工具统一入口。
 * @param {string} action now|forecast|hourly|warning|indices|air|astro
 * @param {object} args { city, days }
 * @param {string} root 仓库根目录（读 config.json）
 */
export async function weatherTool(action, args = {}, root) {
  const cfg = readConfig(root);
  const cityInput = String(args.city ?? cfg.defaultCity ?? '').trim();
  const stateDir = path.join(root, 'state');
  const limit = Number(cfg.quotaPerDay) || 300;
  try {
    if (!cityInput) return { ok: false, error: '没给城市。请说明要查哪个城市（例如"北京"）。' };

    // 日限额 + 最小间隔。放在最前面：城市解析也要走网络，也该计入。
    //
    // 两种调用者的约束不同：
    //   AI 工具  —— 两条都要守（防止她连查刷额度、也防止像客服机器）
    //   管理命令 —— 只守日限额，跳过最小间隔（人手动敲命令，连问两个城市是正常的；
    //               实测连测命令时被"查询太频繁"挡住，纯属自找麻烦）
    const isAdmin = args.adminCommand === true;
    const q = checkQuota(stateDir, limit, isAdmin ? 0 : (Number(cfg.minGapMs) || 1500));
    if (!q.allowed) {
      return { ok: false, error: q.reason, quota: { used: q.used, limit: q.limit }, soft: !!q.soft };
    }

    const city = await resolveCity(cfg, cityInput);
    const where = displayName(city);
    recordCall(stateDir);

    if (action === 'now') {
      const j = await cached(`now:${city.id}`, TTL.now, () => getJson(cfg, `/v7/weather/now?location=${city.id}`));
      const n = j.now;
      const parts = [`${where}现在${n.text}`];
      if (num(n.temp) !== null) parts.push(`${n.temp}°C`);
      if (num(n.feelsLike) !== null && Math.abs(num(n.feelsLike) - num(n.temp)) >= 3) parts.push(`体感${n.feelsLike}°C`);
      if (n.windDir && n.windScale && n.windScale !== '0') parts.push(`${n.windDir}${n.windScale}级`);
      if (num(n.humidity) !== null) parts.push(`湿度${n.humidity}%`);
      const extras = [];
      if (num(n.precip) > 0) extras.push(`降水量${n.precip}mm`);
      if (num(n.vis) !== null && num(n.vis) < 5) extras.push(`能见度${n.vis}km`);
      const out = { ok: true, text: parts.join('，') + (extras.length ? `（${extras.join('，')}）` : ''), city: where, observedAt: n.obsTime };
      // 顺手看一眼预警：不额外增加"查天气"的调用次数（预警有独立 3 分钟缓存），
      // 只在**首次发现**且等级达标时附一句，避免变成复读机。
      const alert = await maybeAlert(cfg, city, where, stateDir);
      if (alert) { out.text += `\n⚠️ ${alert.text}`; out.alert = alert; }
      return out;
    }

    if (action === 'forecast') {
      const days = Math.min(Math.max(Number(args.days) || 3, 1), 7);
      const api = days <= 3 ? '/v7/weather/3d' : '/v7/weather/7d';
      const j = await cached(`d${days > 3 ? 7 : 3}:${city.id}`, days > 3 ? TTL.d7 : TTL.d3, () => getJson(cfg, `${api}?location=${city.id}`));
      const list = (j.daily ?? []).slice(0, days);
      const lines = list.map((d, i) => {
        const label = i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : fmtDay(d.fxDate);
        let s = `${label}${d.textDay}`;
        if (d.textDay !== d.textNight) s += `转${d.textNight}`;
        s += `，${d.tempMin}~${d.tempMax}°C`;
        if (num(d.precip) > 0) s += `，降水${d.precip}mm`;
        if (num(d.uvIndex) >= 6) s += `，紫外线强`;
        return s;
      });
      return { ok: true, text: `${where}：\n${lines.join('\n')}`, city: where };
    }

    if (action === 'hourly') {
      const j = await cached(`h24:${city.id}`, TTL.h24, () => getJson(cfg, `/v7/weather/24h?location=${city.id}`));
      const list = (j.hourly ?? []).slice(0, 12);
      const lines = list.map((h) => {
        const t = h.fxTime.slice(11, 16);
        let s = `${t} ${h.text} ${h.temp}°C`;
        if (num(h.pop) > 20) s += ` 降水概率${h.pop}%`;
        return s;
      });
      return { ok: true, text: `${where}未来 12 小时：\n${lines.join('\n')}`, city: where };
    }

    if (action === 'warning') {
      const j = await cached(`warn:${city.id}`, TTL.warning, () => getJson(cfg, `/v7/warning/now?location=${city.id}`));
      const list = j.warning ?? [];
      if (!list.length) return { ok: true, text: `${where}目前没有天气预警。`, city: where, count: 0 };
      const lines = list.map((w) => `【${w.title}】${w.severityColor ? `（${w.severityColor}）` : ''}${String(w.text ?? '').slice(0, 160)}`);
      return { ok: true, text: `${where}有 ${list.length} 条天气预警：\n${lines.join('\n')}`, city: where, count: list.length };
    }

    if (action === 'indices') {
      const types = String(args.types ?? '1,3,5,8');
      const j = await cached(`idx:${city.id}:${types}`, TTL.indices, () => getJson(cfg, `/v7/indices/1d?location=${city.id}&type=${encodeURIComponent(types)}`));
      const lines = (j.daily ?? []).map((x) => `${x.name}：${x.category}。${String(x.text ?? '').slice(0, 90)}`);
      return { ok: true, text: `${where}生活指数：\n${lines.join('\n')}`, city: where };
    }

    if (action === 'air') {
      if (!city.lat) throw new Error('空气质量需要经纬度，请用城市名查询');
      const j = await cached(`air:${city.lat},${city.lon}`, TTL.air, () => getJson(cfg, `/airquality/v1/current/${city.lat}/${city.lon}`));
      const idx = (j.indexes ?? []).find((x) => x.code === 'cn-mee') ?? (j.indexes ?? [])[0];
      if (!idx) return { ok: false, error: `${where}没有空气质量数据` };
      const pm = (j.pollutants ?? []).find((p) => p.code === 'pm2p5');
      let s = `${where}空气质量${idx.category}（AQI ${idx.aqi}）`;
      if (pm?.concentration?.value !== undefined) s += `，PM2.5 ${pm.concentration.value}${pm.concentration.unit ?? ''}`;
      return { ok: true, text: s, city: where };
    }

    if (action === 'astro') {
      // date 必须是**本地** YYYYMMDD。用 toISOString()（UTC）会在 UTC+8 的凌晨
      // 差一天——实测 07:55 本地时 UTC 还是前一天，接口直接 400。
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const j = await cached(`astro:${city.id}:${ymd}`, TTL.astro, () => getJson(cfg, `/v7/astronomy/sun?location=${city.id}&date=${ymd}`));
      const sr = String(j.sunrise ?? '').slice(11, 16);
      const ss = String(j.sunset ?? '').slice(11, 16);
      return { ok: true, text: `${where}今天日出 ${sr || '?'}，日落 ${ss || '?'}`, city: where };
    }

    return { ok: false, error: `未知的 action：${action}（可用 now/forecast/hourly/warning/indices/air/astro）` };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 供测试/调试：清空缓存。 */
export function clearWeatherCache() {
  cityCache.clear();
  dataCache.clear();
}
