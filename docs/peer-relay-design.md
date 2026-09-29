# server.peer（对端实例联动）调研与落地设计

> 状态：**调研完成，方案待确认，未写代码**。
> 关联：多开机制见 `docs/multi-instance.md`。

---

## 1. 现状调研（先讲事实）

### 1.1 字段来自哪里

本机 `~/.local/share/qq-agent/config.json` 的 `server` 里存在：

```json
"server": {
  "port": 3410,
  "token": "",
  "alias": "Mio",
  "peer": {
    "enabled": true,
    "name": "Asaba",
    "profile": "2",
    "dataDir": "",
    "port": 3211,
    "wsUrl": "ws://127.0.0.1:3003",
    "httpUrl": "http://127.0.0.1:3002"
  }
}
```

### 1.2 代码消费情况：**零消费**

对仓库与已安装版做了全量 grep，`server.alias` / `server.peer`（及 `对端`）在
`src/`、`ui/`、`plugins/`、`skills/`、`electron/` 中**没有任何读取方**。
`updateConfig` 用 deepMerge 会把前端回传的任意字段存进 config.json —— 所以这些
字段只是"存下来了，没人用"。典型死配置。

### 1.3 端口语义与代码不一致（关键）

`src/profile.js` 的 `portOffset() = PROFILE_ID * 100`（N=2 → +200）：

| 项 | peer 字段里的值 | 按代码 profile=2 推导 | 是否一致 |
|---|---|---|---|
| 控制台端口 | 3211（=3210+1） | 3410（=3210+200） | ❌ |
| OneBot ws | 3003（=3001+2） | 3201（=3001+200） | ❌ |
| OneBot http | 3002（=3000+2） | 3200（=3000+200） | ❌ |

说明 `peer` 字段是按**旧版/手写的 "+N"** 语义配的，没有跟着 `portOffset()=N*100`
的机制对齐。**一旦实现读取方，必须先决定以哪套语义为准。**

### 1.4 现成的跨实例基础设施（实现时直接复用）

| 能力 | 位置 | 说明 |
|---|---|---|
| 本实例 HTTP API | `src/server.js` + `src/routes.js` | 控制台 `server.port`（+100N）；token 空时仅 loopback 可访问 |
| 鉴权 | `src/app.js` `authorize()` / `originAllowed()` | `x-console-token` / `?token=`；来源校验防 CSRF / DNS rebinding |
| 状态接口 | `GET /api/status`、SSE `/api/events`（`emit('status')`） | 现成的健康/会话/插件状态 |
| 配置脱敏 | `sanitizeConfig` | 对端拉取配置也是脱敏后的 |
| 进程锁 | `src/instance-lock.js` | 每个实例独立锁，多开天然不互斥 |
| 实例身份显示 | `describeInstance()` → `QQ Agent #2` | 托盘/窗口标题 |

---

## 2. 需求语义：先分清要哪种"联动"

`peer` 字段名 + 本机配置（`name: "Asaba"`，主实例 `alias: "Mio"`）看，意图是
**同机两个 bot 实例之间的关系**。有三种可能语义，改动量与风险差别很大：

### 方案 A：对端状态面板（只读）—— 推荐起步
本实例定时去问对端 `GET /api/status`，在 UI 上显示一张"对端实例"卡片：
在线/离线、版本、会话数、活跃技能数、最近出错。
- 改动：后端一个探测函数（fetch + 超时 + token）+ 前端一张卡片。**完全不触碰消息流。**
- 风险：最低。只读、单向、可随时关。

### 方案 B：对端消息转发 / 联勤
主实例按指令把内容转发给对端实例（或相反），实现"两台 bot 互相带话"。
- 改动：跨实例会话映射、去重、防转发回环、权限/白名单设计。社交敏感操作。
- 风险：高。**不建议第一版做。**（工具链里 `tools.crossChatSend` 已有单实例内的
  跨会话门禁，可作参考：默认关、白名单、上限。）

### 方案 C：跨实例账号池 / 额度负载均衡
`account-pool` 插件做跨进程调度，共享模型 API 额度。
- 改动：最大，超出"多开"本意。另立议题。

> 下面按 **方案 A** 展开设计（唯一低风险、能立刻体现价值的方向）。

---

## 3. 字段规范（方案 A 的配置契约）

在现有字段基础上**收紧语义**，并且**与 `portOffset()` 对齐**：

```jsonc
"server": {
  "port": 3210,                 // 本实例（+100N）
  "alias": "Mio",               // 本实例显示名（UI 用，缺省 = describeInstance()）
  "peer": {
    "enabled": false,           // 总开关；默认关，避免每 N 秒轮询另一个进程
    "name": "Asaba",            // 对端显示名（缺省 = 对端 describeInstance()）
    "profile": "2",             // 对端实例号 → 推导对端 dataDir/端口（唯一必填）
    "dataDir": "",              // 可选覆盖：对端数据目录（缺省 ~/.local/share/qq-agent-N）
    "port": 0,                  // 可选覆盖：对端控制台端口（缺省 3210+100N）
    "wsUrl": "",                // 可选覆盖：对端 WS（当前版本不用，保留占位）
    "httpUrl": "",              // 可选覆盖：对端 HTTP（缺省 http://127.0.0.1:3210+100N）
    "token": "",                // 对端控制台 token（对端非空时才需要；只存本机、不进 API 回传）
    "pollMs": 15000,            // 轮询间隔（默认 15s；enabled=false 时不轮询）
    "timeoutMs": 4000           // 单次探测超时
  }
}
```

解析规则（代码里一个 `resolvePeerTarget(config)` 函数）：
1. `profile` 为空且 `enabled=true` → 配置不完整，日志警告并视为关闭；
2. 优先显式字段（`dataDir` / `port` / `httpUrl`），缺省按 `profile` 用与
   `src/profile.js` **同一套** `portOffset()` 推导，保证语义唯一；
3. 本机遗留值（3211/3003/3002）**不兼容新语义** → 迁移时以"显式覆盖"方式
   保留或直接改回推导值；文档里明确说明。

---

## 4. 后端设计

```
┌──────────────┐   GET /api/status (带 token)   ┌──────────────┐
│  实例 #1      │ ─────────────────────────────▶ │  实例 #2      │
│  peer 探测器  │ ◀───────────────────────────── │  (自己的 3410) │
└──────────────┘   200 { …脱敏 status… } / 超时   └──────────────┘
```

- 新模块建议放 `src/peer.js`（或挂 `server.js` 内），职责单一：读配置 → 轮询 →
  产出 `{ ok, at, status?, error? }`，通过现有 `emit('status', { peer: … })` 推给前端。
- 探测函数：
  ```js
  async function fetchPeerStatus(target) {
    const url = `${target.httpUrl}/api/status`;          // loopback 专用
    const headers = target.token ? { 'x-console-token': target.token } : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(target.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    return sanitizeStatus(body);   // 只摘需要的字段，不透传明文
  }
  ```
- 安全要点：
  - **只允许 loopback 目标**：`target.httpUrl` 的 host 必须 ∈ `127.0.0.1`/`localhost`/`::1`，
    否则视为非法配置直接关闭（防被配置文件里的恶意地址变成 SSRF 出口）；
  - 对端返回体只透传 **白名单字段**（版本/会话数/插件摘要等），任何带密钥/原始配置的
    块一律不转发；
  - 对端 token 字段**不进** `GET /api/config` 的返回值（`sanitizeConfig` 的
    `token` 模式已覆盖 `peer.token`——见 `SECRET_KEY_PATTERN`，含 `sessdata` 增强后仍适用）；
  - 轮询只在本实例 `server.peer.enabled=true` 时进行；重启后默认关。

---

## 5. 前端设计（最小实现）

- 在设置页（或首页）加一张"对端实例"卡片：
  - 有数据：`对端：Asaba · 在线 · v0.4.4 · 会话 3 · 插件 12 个生效` + 最近一次出错原因；
  - 无数据：`对端未配置/离线（HH:MM:SS 起无响应）`；
  - 配置入口：仅在设置页新增 `server.peer` 一组输入（enabled / name / profile / httpUrl / token）。
- 数据来源：订阅现有 `/api/events` 的 `status` 事件里新增的 `peer` 块，不新增轮询。

---

## 6. 分阶段实施

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| P0 | `src/peer.js` + `resolvePeerTarget` + 轮询 + SSE 推送 | `src/profile.js` / `sanitizeConfig` | 低 |
| P1 | 设置页 `server.peer` 表单 + 对端状态卡片 | P0 | 低 |
| P2 | 指令转发（方案 B）——**需单独评审**：白名单/去重/防回环/会话映射 | P0/P1 | 高 |

建议先做 P0+P1（"让多开看得见"），P2 单独开议题。

---

## 7. 待确认项（拍板后才能动代码）

1. **语义**：确认走方案 A（状态互通）？还是其实想要 B（消息转发）？
2. **端口语义**：`peer.profile=2` 按现行 `+100N`（3410/3201/3200）对齐，
   还是接受遗留的 `+1/+2` 显式覆盖（不推荐，会造成跨版本混乱）？
3. **token**：对端设置了控制台 token 时，本机 `peer.token` 如何录入（设置页输入即可）？