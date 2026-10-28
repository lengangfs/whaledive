# 鲸潜 · Whale Dive

> 把 QQ 群聊接成 AI 智能体的栖息地，而不只是一根转发管子。

[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## 这是什么

一个 **QQ ↔ [DeepSeek Harness](https://github.com/deepseek-ai) 智能体** 的双向桥接。

QQ 消息进来 → 变成智能体的唤醒提示词 → 智能体回复 → 发回 QQ。

但它不止于此 —— 它让一个 AI 角色能**长期活在** QQ 群里：

- 记得住人（群友印象，永久保存）
- 记得住日子（每天写日记，跨天留存）
- 收藏群里的图（图片/语音归档，因为 QQ 的媒体链接一天后必然失效）
- 会潜水会冒泡（按群配置唤醒策略，不刷屏但也不装死）
- 崩溃了会自己爬起来（守护进程 + 上下文预算管理）

名字来自：智能体的默认状态是 `diving`（潜水），而这一整套东西是它潜游的水域。

---

## 核心特性

### 会话与人格

- **双层上下文**：DSH 会话上下文 + 桥接注入的角色卡/记忆/日记
- **按群人格覆盖**：同一个机器人可以在 A 群是「安酱」、在 B 群是「小鲸鱼」，互不串味
- **人格防割裂**：角色名、角色卡、日记注入三者按会话对齐，不会出现"名字写着 A、卡片是 B"的错位
- **上下文预算**：超过阈值自动退休会话重开（保留记忆、重建上下文），避免无限膨胀导致每轮 prefill 几十秒

### 记忆系统

| 类型 | 生命周期 | 用途 |
| --- | --- | --- |
| 群友印象 | 永久 | "这个人是谁、聊过什么、什么脾气" |
| 进行中话题 | 24 小时 | 现在正在聊什么 |
| 未说出口的想法 | 2 小时 | 想说但还没说的话 |
| 日记 | 永久（文件） | 跨天记忆，每晚 23:30 提醒写 |

### 媒体归档

QQ 的图片/语音/文件 URL 带短时效 `rkey`，**一天后必然 400**。桥接在收到消息时就把媒体落盘：

- 两层清理：按保留天数（默认 30 天）+ 按总容量（默认 12GB）
- **容量不足时淘汰最旧的**（keep-newest 语义），不会因为盘满了就丢掉今天的图
- 语音走 SnowLuma 的 `get_record` 转 mp3（QQ 原生是 SILK_V3，无法直接播放）

### 工具集

智能体在聊天中可主动调用 40+ 个工具（见下文），覆盖：

- **发消息**：单条/分条/引用回复/@/戳一戳
- **看消息**：未读、最近、详情、合并转发、图片（视觉模型可直接看图）
- **表情包**：收藏、查看、发送
- **语音**：TTS 合成、语音库发送
- **记忆**：写入/查询/删除
- **日记**：写、读、列表
- **音乐**：搜歌、查歌词和详情、分享
- **天气**：实时/预报/预警/生活指数/空气质量/日出日落
- **其它**：等待消息、设置唤醒、反馈

### 运维自愈

- **守护进程**：崩溃 5 秒后自动重启
- **DSH 端口自动发现**：DSH 桌面版每次启动随机选端口，桥接在启动前用 `tasklist` + `netstat` 从进程反查真实端口并自动改写配置
- **幽灵回合检测**：识别"看起来在跑其实卡死"的回合，双重确认后才自愈
- **日志自动修剪**：只对超阈值的追加日志做原子替换，绝不触碰账本和状态文件

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                          QQ 客户端                            │
└───────────────────────────┬──────────────────────────────────┘
                            │ QQ 协议
┌───────────────────────────▼──────────────────────────────────┐
│                 SnowLuma（OneBot v11 网关）                   │
│                   HTTP :3000   WS :3001                      │
└───────────────────────────┬──────────────────────────────────┘
                            │ OneBot 事件 / API
┌───────────────────────────▼──────────────────────────────────┐
│                      qq-bridge（本项目）                      │
│  ┌─────────────┬──────────────┬─────────────┬──────────────┐ │
│  │ 会话状态机   │ 角色/记忆注入 │ 媒体归档    │ 工具 MCP      │ │
│  │ 唤醒/潜水    │ 日记/印象     │ 语音转码    │ 40+ 工具      │ │
│  └─────────────┴──────────────┴─────────────┴──────────────┘ │
│                       HTTP :3100（控制台）                    │
└───────────────────────────┬──────────────────────────────────┘
                            │ DSH Web API（事件流 + 提示词）
┌───────────────────────────▼──────────────────────────────────┐
│              DeepSeek Harness（智能体运行时）                 │
└──────────────────────────────────────────────────────────────┘
```

**三个进程，两段协议**：

| 组件 | 端口 | 职责 |
| --- | --- | --- |
| SnowLuma | 3000 / 3001 | QQ ↔ OneBot v11 协议转换 |
| qq-bridge | 3100 | 状态机、上下文注入、工具服务、控制台 |
| DeepSeek Harness | 动态 | 智能体推理与工具执行 |

DSH 的端口是**动态的**（每次启动重新选），桥接会自动发现。

---

## 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22.13 | 本项目用 ESM + 原生 fetch |
| [SnowLuma](https://github.com/SnowLuma) | ≥ 1.14.x | OneBot v11 网关，需要一个 QQ 账号 |
| [DeepSeek Harness](https://github.com/deepseek-ai) | 桌面版 | 智能体运行时 |
| ffmpeg | 任意 | 语音转码（可选，没有会降级） |

### 步骤

```bash
# 1. 克隆
git clone https://github.com/lengangfs/whaledive.git
cd whaledive

# 2. 安装依赖
npm install

# 3. 复制配置并填写
cp config.example.json config.json
# 编辑 config.json：填 SnowLuma 的 accessToken、你的 QQ 号等

# 4. 启动
node scripts/ensure-dsh-port.mjs   # 校正 DSH 端口
node src/bridge.js
```

Windows 下推荐用 `guard.cmd`（带崩溃自动重启）或 `启动桥接.cmd`。

### 验证

```bash
# 控制台状态
curl -H "x-console-token: $(cat state/console-token)" http://127.0.0.1:3100/api/status
# → {"mode":"reserved2","dshReady":true,...}
```

---

## 配置

配置文件是 `config.json`（**已被 .gitignore 排除，不会误提交**）。完整字段见 `config.example.json`，关键项：

### 必填

```jsonc
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:PORT",   // DSH 地址，端口会变，用 ensure-dsh-port.mjs 自动校正
    "provider": "deepseek-account",
    "model": "deepseek-flash"
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "..."                   // SnowLuma 的 access token
  },
  "ownerQQ": 10001,                        // 主人 QQ（不受频率限制、可执行管理命令）
  "allow": {
    "private": [10001, 10002],             // 私聊白名单
    "groups": [123456789]                  // 群白名单
  }
}
```

### 人格与记忆

```jsonc
{
  "role": {
    "maxInjectChars": 6000,
    "overrides": {                          // 按会话覆盖人格卡
      "group:123456789": "小鲸鱼"
    }
  },
  "diary": {
    "enabled": true,
    "hour": 23, "minute": 30,               // 每晚提醒写日记
    "injectDays": 3                          // 唤醒时回注最近几天
  }
}
```

### 媒体归档

```jsonc
{
  "media": {
    "enabled": true,
    "retainDays": 30,                       // 按天数清理
    "maxTotalMB": 12288,                    // 按总容量清理（满了淘汰最旧）
    "recordFormat": "mp3"                   // QQ 语音是 SILK_V3，必须转码
  }
}
```

### 上下文预算

```jsonc
{
  "socialV2": {
    "contextBudget": {
      "enabled": true,
      "maxTokens": 120000,                  // 超过就退休会话重开
      "checkIntervalMs": 300000
    }
  }
}
```

---

## 工具清单

智能体可调用的 MCP 工具（节选）：

| 分类 | 工具 |
| --- | --- |
| 发消息 | `qq_send_message` `qq_send_burst` `qq_reply` `qq_send_group_message` `qq_send_private_message` |
| 读消息 | `qq_get_unread_messages` `qq_get_recent_messages` `qq_get_message_detail` `qq_get_forward_msg` |
| 图片 | `qq_get_message_images`（视觉模型可直接看图）`qq_send_sticker` |
| 表情 | `qq_list_stickers` `qq_sticker_note` `qq_collect_sticker` |
| 语音 | `qq_send_voice` `qq_list_voices` |
| 记忆 | `qq_memory_append` `qq_memory_query` `qq_memory_remove` |
| 日记 | `qq_diary_write` `qq_diary_read` |
| 音乐 | `qq_search_music` `qq_music_info` `qq_send_music` |
| 天气 | `qq_get_weather` |
| 会话 | `qq_get_prompt` `qq_social_state` `qq_set_wake_config` `qq_wait_for_messages` `qq_mark_read` |
| 其它 | `qq_send_poke` `qq_get_active_members` `qq_report_feedback` |

管理命令通过 `/a <子命令>` 触发（仅主人可用），群友用 `/help` 看帮助卡片。

---

## 设计笔记

开发过程中踩过的坑，写下来给后来人少走弯路：

**1. 别用可变状态描述"正在思考"**

早期的"幽灵回合"问题：事件流断了但内存里还标记着"回合进行中"，于是新消息全部入队等一个永远不会结束的回合。修复的关键是**用时间差判断**，而不是看某个布尔值。

**2. 摘要类文件不能用"到上限就跳过"**

媒体归档第一版写反了：容量满了就跳过新文件。语义完全颠倒 —— 归档的意义是**留住最近的**。正确做法是淘汰最旧的到 90%，给新数据腾地方。

**3. 静默的 try/catch 会吃掉作用域错误**

有个 bug 表现是"角色卡整个消失，日志里一个错都没有"。根因是顶层函数引用了 `main()` 里的局部变量，抛 `ReferenceError`，被调用方的 `try { } catch { return '' }` 吞成空字符串。

**4. 非 ASCII 字符可能破坏 batch 脚本**

Windows `.cmd` 文件在特定代码页下，`rem` 里的一行中文可能让解析器错位，导致整个脚本静默退出。**注释也用 ASCII**。

**5. 平台能力有上限，绕不过去就诚实降级**

QQ 音乐卡片三种方案全被拒（"发送者版本过低"），根因是客户端协议版本。降级成"文字 + 链接"并在工具描述里写清楚，比让 AI 以为自己发了卡片好。

**6. 沙箱会杀子进程**

如果桥接是被某个受限环境拉起来的，那个环境退出时会把子进程一起带走。守护进程必须由**系统级任务**启动，不能靠上一个进程 fork。

---

## 已知限制

- **需要自己准备 QQ 账号**，且高频发言可能触发风控
- **依赖非官方接口**：SnowLuma 的 OneBot 协议、网易云音乐检索 —— 都随时可能失效
- **DSH 协议会变**：本项目针对特定协议代际实现，DSH 大版本更新可能需要适配
- **语音是 SILK_V3**：需要 ffmpeg 或网关转码，不能直接播放
- **音乐卡片不支持**：QQ 客户端协议版本较旧时只发文字链接
- **仅 Windows 验证充分**：`guard.cmd`、计划任务、ACL 硬化都是 Windows 特有的

---

## 开发

```bash
# 只读桥接的单元测试（不需要 QQ / DSH）
npm run test:hardening
npm run test:token
npm run test:md
npm run test:role-card
npm run test:preset-prompt
```

跑完整测试需要 SnowLuma 和 DSH 都在线。

---

## 协议与合规

本项目是**连接层**，不含任何 QQ 协议实现，也不鼓励违反服务条款的使用方式。请自行确认所在地区和使用场景的合规性。

---

## License

[MIT](LICENSE)

---

<p align="center">
  <i>鲸在水下潜游，偶尔浮上来换气。</i>
</p>
