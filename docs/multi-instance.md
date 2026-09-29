# QQ Agent 实例多开（multi-instance）部署指南

> 适用：QQ Agent Linux 移植版（v0.4.4+）。本文讲清楚**多开在代码里是怎么实现的**、
> **第二个实例要做什么**、以及**踩坑对照表**。

---

## 1. 机制速读：多开是怎么实现的

多开 = **一份程序，跑 N 个进程，每个进程一套"数据目录 + 端口 + 一个 QQ 号"**，互不干扰。

| 层 | 负责的东西 | 代码位置 |
|---|---|---|
| 实例身份 | `QQ_AGENT_PROFILE=N`（N 为数字）→ 数据目录后缀 `-N`、端口偏移 `N*100` | `src/profile.js`（`profileSuffix()` / `portOffset()`） |
| 数据隔离 | 数据目录落到各自 `DATA_DIR`：`~/.local/share/qq-agent-N`（Linux）/ `<app>/data-N`（Windows） | `src/platform.js` `resolveDataDir()`、`src/config.js` |
| 端口隔离 | 控制台 `server.port = 3210 + 100N`；SnowLuma OneBot `ws://127.0.0.1:3001+100N`、`http://127.0.0.1:3000+100N` | `src/config.js:194-195, 421` |
| 防重复（同一目录） | Electron `requestSingleInstanceLock` + `DATA_DIR/qq-agent.lock`（含 PID，原子创建） | `electron/main.js:227`、`src/instance-lock.js` |
| 对外的身份显示 | 窗口标题 / 托盘 tooltip 显示 `QQ Agent #2` | `electron/main.js:476,697` + `src/profile.js` `describeInstance()` |

要点：

- **环境变量优先级**：`QQ_AGENT_DATA_DIR`（显式指定数据目录，最高）> `QQ_AGENT_PROFILE`（推导 `-N` 目录）> 平台默认。`QQ_AGENT_PORT` 可单独覆盖控制台端口。
- 每个实例的数据目录里**各有各的** `config.json`、`qq-agent.lock`、会话、记忆、affinity——
  因此**多开的实例之间配置天然互不影响**（含插件/技能设置，见下文 §3）。
- 单实例锁是**按数据目录**的：不同目录 = 不同锁 = 可以并行；同一目录再启动会被拒绝
  （`src/app.js:128` 会提示"请用不同的 QQ_AGENT_DATA_DIR"）。

### 端口对照表（按现有 `portOffset = N*100` 语义）

| 实例 | 数据目录 | 控制台端口 | SnowLuma OneBot WS / HTTP |
|---|---|---|---|
| #1（默认） | `~/.local/share/qq-agent` | 3210 | 3001 / 3000 |
| #2（`QQ_AGENT_PROFILE=2`） | `~/.local/share/qq-agent-2` | 3410 | 3201 / 3200 |
| #3（`QQ_AGENT_PROFILE=3`） | `~/.local/share/qq-agent-3` | 3510 | 3301 / 3300 |

> ⚠️ 注意：偏移是 `N*100`（不是 `N`）。若你的主实例**手动改过** `server.port`，
> 按公式推算的 #2 默认端口可能撞车 —— 撞了就显式指定 `QQ_AGENT_PORT`，
> 或换一个不与主实例冲突的 `QQ_AGENT_PROFILE`。

---

## 2. 第二个实例怎么开（实际操作）

### 前提

- 第二个实例 = 第二个 QQ 号。**SnowLuma 一份进程 = 一个 QQ 账号**，所以第二个 bot
  需要自己的 SnowLuma 工作副本（不是再开一个进程就行）。
- 同一台机器跑两份 QQ 客户端（/opt/QQ）时，SnowLuma 靠注入进程工作，注意
  [多 QQ 进程注入歧义](../../docs/AI-部署交接.md)（"同时存在多个 QQ 进程，选有窗口的那个"）。

### 步骤

**① 准备第二份 SnowLuma 工作副本**（独立目录、独立端口，否则会被"已在运行"误判挡住）

```bash
# 从已安装包里拷一份出来（也可以用仓库里的 snowluma/）
cp -r "/opt/QQ Agent/resources/app.asar.unpacked/snowluma" "$HOME/snowluma-2"
```

第一次启动 SnowLuma #2 后，把它的 WebUI 端口从默认 5099 改成**别的**（例如 5199），
保证和 SnowLuma #1 不冲突。改法二选一：

- 直接改它生成的运行时配置（拷贝完先启动一次再改）：
  ```bash
  # 编辑 $HOME/snowluma-2/config/runtime.json 里的 webuiPort，改为 5199
  ```
- 或用它的 WebUI 设置页改端口。

**② 启动实例 #2**

```bash
QQ_AGENT_PROFILE=2 qq-agent            # 已安装的 deb/rpm 命令名
# AppImage 方式：
# QQ_AGENT_PROFILE=2 ./qq-agent-v0.4.4-x86_64.AppImage --no-sandbox
# headless 方式（仓库内开发）：
# QQ_AGENT_PROFILE=2 npm run server
```

启动后窗口标题/托盘显示 **QQ Agent #2**；数据目录 `~/.local/share/qq-agent-2`
自动创建（**不需要手动拷贝**主实例目录 —— 第一次启动会用出厂默认配置）。

**③ 在实例 #2 里指认第二份 SnowLuma**

- 打开窗口 → 设置 → SnowLuma：
  - `程序目录`：填 `$HOME/snowluma-2`（**必须**，否则两个实例共用同一份 SnowLuma）
  - `自动启动`：按需打开（建议先手动启动一次验证）
- 保持 `WS 地址` / `HTTP 地址` 为实例 #2 的默认（`ws://127.0.0.1:3201` / `http://127.0.0.1:3200`）。

**④ 登录第二个 QQ 号并配 OneBot**

- 打开 SnowLuma #2 的 WebUI（`http://127.0.0.1:5199`），扫码登录第二个 QQ 号；
- 在它的 OneBot 配置里，把 WebSocket / HTTP 端口设成 **3201 / 3200**（与实例 #2 默认一致）；
- 回到实例 #2 窗口点「启动 SnowLuma」（或开自动启动）。

**⑤ 校验**

- 实例 #2 控制台能看到自己的 SnowLuma 日志；
- 两个 bot 各自只响应自己 QQ 号的消息，同一句群里 @ 不会出现双份回复；
- 如果出现"重复回复"或"连不上"，见 §4 排查表。

---

## 3. 多开时，插件/技能设置是各管各的吗？

**是的，天然隔离。** 所有插件/技能设置存在各自的 `DATA_DIR/config.json` 里：

- `config.skills.<技能id>` —— 每个插件的设置/开关（如 `thinking-adapters`）、每个技能的设置；
- `config.tools.overrides` / `tools.categories` / `tools.enabled` —— 工具级开关；
- `config.plugins.*`、`config.<插件id>` —— 部分插件自带的配置命名空间。

实例 #1 里改插件设置**不会**影响实例 #2。注意：**不要把实例 #1 的 `config.json`
整份拷给实例 #2** —— API Key、白名单、人设、屏蔽名单等都是按实例独立设计的，
拷过去等于两台 bot 共用一个账号体系。

---

## 4. 排查对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动第二个实例报"已有 QQ Agent 实例在运行（PID …）" | 两个实例用了**同一个数据目录**（漏了 `QQ_AGENT_PROFILE` / `QQ_AGENT_DATA_DIR` 设成一样） | 确认 `QQ_AGENT_PROFILE`/`QQ_AGENT_DATA_DIR` 各自独立 |
| 双击/启动后闪退、无反应 | Electron 单实例锁被主实例占着（`requestSingleInstanceLock`） | 这是**正常行为**：第二实例会唤出主实例窗口；要多开请走 §2 的环境变量方式 |
| 实例 #2 里点「启动 SnowLuma」显示"已在运行" | `snowluma.dir` 仍指向主实例那份（WebUI 端口探测撞上） | 在实例 #2 设置里把 `SnowLuma 程序目录` 指到独立副本 `~/snowluma-2` |
| 控制台端口撞车 | 手改过主实例 `server.port`，与公式端口冲突 | 显式设 `QQ_AGENT_PORT`，或换 `QQ_AGENT_PROFILE` |
| 群里出现双份回复 | 两个实例连到了**同一份** SnowLuma（同一个 WS 地址） | 检查两边 `snowluma.wsUrl`：实例 #2 必须是 `3201` 而不是 `3001` |
| 两个 QQ 客户端时注入错账号 | SnowLuma 注入哪个 QQ 进程有歧义 | 参考 `docs/AI-部署交接.md` 的多进程选窗口规则，或用不同会话登录 |
| 实例 #2 的数据写到了 #1 的目录 | 某个插件自己拼路径而不是复用 `DATA_DIR` | 这是插件 bug；项目内插件一律 `import { DATA_DIR } from '../../src/config.js'` |

---

## 5. 现网这台机器为什么是 3410？（与本机配置对账）

当前 `~/.local/share/qq-agent/config.json` 里 `server.port = 3410`（= 3210 + 200，
即 **profile #2 的默认端口**），但数据目录是无后缀的 `qq-agent`（profile #1）。
也就是说主实例的端口是**手动设的**，与"profile 推导"不一致。这会导致一个坑：
直接 `QQ_AGENT_PROFILE=2 qq-agent` 时，实例 #2 的默认端口恰好也是 3410 → 撞车。

处理：主实例若想保持 3410，第二个实例请显式指定：

```bash
QQ_AGENT_PROFILE=2 QQ_AGENT_PORT=3510 qq-agent
```

或把主实例 `server.port` 改回 3210 后重启，让两个实例都走公式端口。

> 另：该 config 里还有 `server.alias` / `server.peer` 两个自定义字段，
> 目前**没有任何代码消费它们**（详见 `docs/peer-relay-design.md`），不影响多开。

---

## 6. 本机落地实录（2026-09-29）

> 记录这台机器上已按 §2/§5 完成的实例 #2 部署，供巡检与故障定位对照。

| 项 | 实例 #1（主，Mio） | 实例 #2（Asaba） |
|---|---|---|
| 数据目录 | `~/.local/share/qq-agent` | `~/.local/share/qq-agent-2` |
| 控制台端口 | 3410（config `server.port` 手改） | 3510（`QQ_AGENT_PORT=3510` 显式） |
| SnowLuma 副本 | 内置 `/opt/QQ Agent/resources/app/snowluma` | `~/snowluma-2`（已清空原拷贝里的登录态与 logs） |
| SnowLuma WebUI | 5099 | 5199（首次启动后改；现在还没启动） |
| OneBot WS / HTTP | 3001 / 3000 | 3201 / 3200（在 snowluma-2 设置里配） |
| `snowluma.autoLaunch` | true | **false**（等扫码登录后再开） |
| 账号 | Mio（2215188985，已在线） | Asaba（待扫码登录） |
| 配置来源 | 既有 config.json（未手工改） | 从主 config 复制后改：端口/别名/snowluma 指向/人设 Asaba；`plugins.proactiveChat.enable=false`（默认不主动发） |

实例 #2 看护（与主实例同款 cron，基于数据目录锁文件判活，避免与主进程名混淆）：

```cron
* * * * * L="$HOME/.local/share/qq-agent-2/instance.lock"; P=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$L" 2>/dev/null); ALIVE=$([ -n "$P" ] && kill -0 "$P" 2>/dev/null && echo 1); if [ "$ALIVE" != 1 ] && [ -f "$HOME/.local/share/qq-agent-2/config.json" ]; then echo "relaunch-2 $(date '+%F %T')" >> /home/kmy/.config/qq-agent/watchdog.log; DISPLAY=:0 nohup env QQ_AGENT_PROFILE=2 QQ_AGENT_PORT=3510 /opt/QQ\ Agent/qq-agent >/dev/null 2>&1 & fi
```

> ⚠️ 注意：主实例的进程名与 #2 相同（都是 `/opt/QQ Agent/qq-agent`），**不能**用
> pgrep 按进程名区分死活；#2 看护改用数据目录锁。若要手拉 #2，注意 `DISPLAY=:0`
> 与 `QQ_AGENT_PROFILE=2 QQ_AGENT_PORT=3510` 三个条件都要带上，否则会撞 3410 或进错目录。
> 半自动启动样例见 `examples/multi-instance-launch.sh`（默认 #2 端口已是 3510）。
>
> 待办：Asaba 登录 = snowluma-2 WebUI（5199）扫码 → 配 OneBot 3201/3200 →
> 开 `snowluma.autoLaunch`。共用的是同一台 mongod（27017），知识库按 tenant 隔离。