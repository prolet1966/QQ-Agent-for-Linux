# QQA 服务器适配 · WSL Linux 侧验收报告

| 项目 | 内容 |
| --- | --- |
| 报告版本 | 1.0（2026-10-12） |
| 验收环境 | WSL2 / Ubuntu 26.04 LTS / kernel 6.18.33.2-microsoft-standard-WSL2 |
| 被测对象 | 远端 `codex/server-2c2g` 分支，HEAD `2baf87a` |
| 验收方式 | **真 Linux 环境实测**（非模拟、非 CI 复述），含真实安装与 systemd 托管 |
| 姊妹报告 | `docs/QQA服务器适配-本地验收报告.md`（Windows 侧 + GitHub CI 侧） |
| 明确排除 | 不连接 `47.109.97.184` ECS，不做任何线上操作 |

---

## 摘要

**一句话结论**：在真实 Linux（WSL2 + systemd 259）上，参考实现从源码检出到 systemd 托管安装、再到 2C2G 约束下的端到端压测，**全部环节一次性通过**，且压测事件数与资源峰值与甲方 ECS 实机记录**高度一致**——本报告新增的 systemd 安装、失败回滚、组件 socket、端到端压测四项，是 Windows 侧与 CI 都未能覆盖的空白。

| # | 验收环节 | 结果 |
| --- | --- | --- |
| 1 | 源码 clone 与 LF 检出 | ✅ 工作树 0 改动，纯 LF |
| 2 | 完整测试套件 | ✅ **123/123 通过，0 失败，0 跳过**（11.5 秒） |
| 3 | 发布包构建 | ✅ 931 文件 / `a11d029c…` / 12 秒，官方 `verify-release.mjs` 通过 |
| 4 | 跨环境逐文件比对 | ✅ 与 GitHub CI 产物 **931/931、零独有，仅 2 文件不同**（均可解释） |
| 5 | 服务端到端冒烟 | ✅ 25/25（认证、同源防护、路由、SSE、注销） |
| 6 | systemd 真实安装 | ✅ 安装 7 秒、unit 校验无告警、服务 active+enabled、资源受限正确 |
| 7 | 安装失败自动回滚 | ✅ **5/5**：健康检查超时 → `current` 与 unit sha256 精确复原，数据未动 |
| 8 | 组件托管 socket | ✅ **15/15**：0600 权限 + 6 类非法请求全部拒绝 |
| 9 | 2C2G 约束端到端压测 | ✅ **passed:true，17/17 断言通过**，1250 新 + 5 重复 |

---

## 一、验收环境

```
发行版   Ubuntu 26.04 LTS（WSL2）
内核     6.18.33.2-microsoft-standard-WSL2   arch x86_64
init     systemd（is-system-running: running）  systemd 259 (259.5-0ubuntu3.4)
CPU/内存 宿主 16 核 / 7783 MiB（WSL 默认取半）
磁盘     1007G 总 / 942G 可用
node     /usr/bin/node v22.22.1（真 ELF）；另有 /home/kmy/.local/bin/node v22.23.2
其它     npm 10.9.8、git 2.53.0、python3 3.14.4、gcc 15.2、make 4.4.1
网络     github.com → 200、api.github.com → 200（镜像宿主 Clash 7897）
```

**为什么选这个环境**：`systemd` 作为 PID 1 是本次最大的能力增量——它能真实验证 `qq-agent-server.service` 的托管、限制项、`Restart=on-failure`、`KillMode=control-group`、socket 激活与安装器回滚。另外内核 6.18 与 Ubuntu 26.04 比 CI 的 22.04 更新，构成**第三个独立 Linux 环境**。

> 注：`qqagent-fedora` 发行版已损坏（`fedora-wsl\rootfs\ext4.vhdx` → `ERROR_PATH_NOT_FOUND`），未使用。

---

## 二、源码与检出

工作区 `/home/kmy/qqa-wsl-verify/repo`，由 `git clone --branch codex/server-2c2g` 从 GitHub 取得：

```
HEAD     2baf87a63189805d7f7e8f18d09941bd259fc5ce
分支     codex/server-2c2g
工作树   0 条改动
文件数   287（git 跟踪）  占用 60M
```

**行尾核对**（Linux 默认 `core.autocrlf=false`，检出即 LF）：

| 文件 | Linux 检出 | Windows 工作树 | 差值 |
| --- | --- | --- | --- |
| `src/app.js` | 158,238 B / CRLF **0** | 161,353 B | +3,115 |
| `src/config.js` | 48,431 B / CRLF **0** | 49,248 B | +817 |
| `ui/login.html` | 1,075 B | 1,075 B | 0 |

`src/app.js` 的 158,238 B 与 git blob **逐字节相同**，确认 Linux 检出是仓库权威字节。这也是后文行尾归因的基础。

---

## 三、静态与测试套件

### 3.1 完整测试套件

```
$ npm ci --omit=dev --omit=optional --ignore-scripts     # 3 秒
$ npm test                                                # 11.5 秒
# tests 123   # pass 123   # fail 0   # skipped 0   # duration_ms 11543
退出码 0
```

依赖版本与 lock 范围一致：`js-yaml 5.4.2`、`mongodb 6.21.0`、`undici 6.28.1`、`ws 8.21.3`。

### 3.2 三环境横向对比（同一套件）

| 指标 | Windows 本机 | GitHub CI（Ubuntu 22.04.5） | **WSL（Ubuntu 26.04）** |
| --- | --- | --- | --- |
| `# tests` | 123 | 123 | **123** |
| `# pass` | 116 | 123 | **123** |
| `# fail` | **2** | 0 | **0** |
| `# skipped` | **5** | 0 | **0** |
| 退出码 | 1 | 0 | **0** |
| 耗时 | 507.5 s | 24.0 s | **11.5 s** |

WSL 比 CI 快一倍以上（本地 ext4 + 更快的 CPU）。**Windows 上跳过的 5 个 Linux 专项在此全部真实执行并通过**，那 2 项墙钟容差失败也不再出现——与 CI 结论一致，构成**独立第三方环境**的交叉验证。

---

## 四、发布包构建与跨环境一致性

### 4.1 构建结果

```
$ node scripts/build-server.mjs --output ~/qqa-wsl-verify/build
{
  "archive": "…/qq-agent-server-v0.4.7-node22.tar.gz",
  "sha256": "a11d029c03bd878404884820335fdd2be1a3ac4d64d43d42cda6d2809bb1fa18",
  "files": 931, "sourceCommit": "2baf87a…", "dirty": false, "bytes": 4020321
}
构建用时 12 秒
$ node scripts/server/verify-release.mjs <解包目录>
服务器包校验通过：931 个文件，来源 2baf87a63189805d7f7e8f18d09941bd259fc5ce
```

环境无关性**已被证实**：本机 gzip 1.14 / tar 1.35 / bash 5.3.9 / node 22.22.1，与 GitHub runner（node 22.17.1）不同，但归档生成仍为确定性输出（脚本自行构造 tar 头、gzip 不写时间戳，不依赖系统工具）。

### 4.2 三方逐文件比对

| 环境 | 归档 SHA256 | 文件 | 字节 | commit | 行尾基底 |
| --- | --- | --- | --- | --- | --- |
| 甲方已部署包 | `f10e150c…` | 930 | 4,007,495 | `da6f056` | CRLF 工作树 |
| Windows 重建 C1（复现甲方） | `f10e150c…` | 930 | 4,007,495 | `da6f056` | CRLF 工作树 |
| Windows 重建 B1（当前基线） | `5808147a…` | 930 | 4,007,906 | `da6f056` | CRLF 工作树 |
| GitHub CI | `121014c7…` | 931 | 4,015,867 | `750b8720` | LF |
| **WSL** | **`a11d029c…`** | **931** | **4,020,321** | **`2baf87a`** | **LF** |

**WSL ↔ CI（同内容、同为 LF）**：

```
共有文件 931    内容相同 929    仅 WSL 有 0    仅 CI 有 0    内容不同 2
  docs/QQA服务器适配-本地验收报告.md   WSL 37,286 B  CI 28,076 B   （本报告后续扩写）
  server-manifest.json               同大小 185,981 B              （commit / epoch 不同）
```

**零独有文件、载荷 929/930 逐字节相同**。这是本次最有价值的结论之一：**同一提交在不同 Linux 发行版 + 不同 Node 补丁版 + 不同构建工具版本下，产出完全一致的载荷。**

（CI 那条 `750b8720…` 是 `actions/checkout@v4` 在 PR 事件下生成的**测试合并提交**，其 tree `1fea1cba…` 与 `aa714d3` 的 tree 完全相同——内容一字不差，仅提交对象自身 hash 与时间戳不同。详见姊妹报告第五节。）

### 4.3 WSL ↔ 甲方包：行尾归因

甲方包由 **CRLF 工作树**构建，WSL/CI 由 **LF 检出**构建，故必然存在文本文件差异。量化归因：

```
共有文件 930    内容不同 98
  纯行尾差异（\r\n）: 93 个   合计 +51,534 字节
  内容真差异        : 5 个
  ------------------------------------------------------------
  非文本类文件 398 个，其中不同 0 个
```

5 个真差异：

| 文件 | 说明 |
| --- | --- |
| `docs/server-2c2g-implementation.md` | 甲方包内为打包时版本；源码树为部署后定稿版 |
| `docs/server-2c2g-plan.md` | 同上 |
| `docs/server-2c2g-review.md` | 同上 |
| `docs/server-install.md` | 同上 |
| `server-manifest.json` | commit / epoch / changes 字段不同 |

甲方 `目录说明.md` 已自述：**打包整理时「只移动文件并修正文档路径，不重新构建」**，故包内文档落后于源码树——**属预期，非缺陷**。4 个文档的差异全为路径修正（`validation/` → `构建产物/验证记录/`）与部署结果补记，不涉及代码。

**结论：`\r` 是唯一实质差异来源；398 个非文本文件零差异。**

---

## 五、服务端到端冒烟（CI 完全未覆盖）

以 `QQ_AGENT_DATA_DIR` + `QQ_AGENT_PORT` 完全隔离启动真实服务。

### 5.1 启动与就绪

```
$ QQ_AGENT_DATA_DIR=/tmp/… QQ_AGENT_PORT=33210 QQ_AGENT_CONSOLE_PASSWORD=… node src/server.js
就绪耗时：约 1 秒
监听：LISTEN 0 511 0.0.0.0:33210  users:(("node",pid=520,fd=30))
```

### 5.2 认证与同源防护（全部通过）

| 请求 | 期望 | 实测 |
| --- | --- | --- |
| `GET /api/auth/session`（无 cookie） | 200 `authenticated:false` `environmentPassword:true` `mustChangePassword:false` | ✅ |
| `GET /api/runtime`（无 cookie） | 401 `请先登录控制台` | ✅ |
| `GET /api/events`（无 cookie，SSE） | 401 | ✅ |
| `POST /api/auth/login` + 跨源 `Origin` | **403** `请求来源不被信任` | ✅ |
| `POST /api/auth/login` + `Sec-Fetch-Site: cross-site` | **403** | ✅ |
| `POST /api/auth/login` 错密码 | 401 `密码错误` | ✅ |
| `POST /api/auth/login` 正确密码 | 200 + `set-cookie: qqa_session=…; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800` | ✅ |
| `GET /api/auth/session`（带 cookie） | 200 `authenticated:true` | ✅ |
| 注销后 `GET /api/runtime` | 401 | ✅ |

### 5.3 路由与重定向

未认证时**所有页面路由一律 302 → `/login.html`**（`cache-control: no-store`）：

```
/  /login  /config  /settings  /processes  /snowluma/  /qq-desktop   →  302  Location: /login.html
```

认证后：

```
/                 → 200  text/html  17,302 B（控制台）
/login.html       → 200  text/html   1,075 B
/login.js         → 200  2,065 B     /login.css → 200  737 B
/config 等        → 404（前端使用 hash 路由，非服务端路由，符合设计）
```

### 5.4 关键：SnowLuma 代理版本门禁

```
GET /snowluma/  →  409  text/plain
此 WebUI 版本尚未验证代理兼容性。请通过 SSH 本地转发访问 127.0.0.1:5099。
```

**完全符合计划要求**：未安装 / 版本不匹配时明确回退到 SSH 本地转发提示，而非静默失败。对应 `src/snowluma-proxy.js` 的版本白名单（仅接受 1.14.22）。

### 5.5 2C2G 预设生效（服务端自证）

```
GET /api/runtime →
  mode    = "server"
  preset  = "server-2c2g"
  node    = "v22.23.2"
  incoming.capacity = 512           ← resources.incomingQueue
  incoming.maxBytes = 67108864      ← 64 MiB 积压上限
  …
```

### 5.6 状态诊断聚合

```
GET /api/status → 200，13 个顶层键
  onebot.{connected:false, error:"ECONNREFUSED 127.0.0.1:3001",
          diagnosis:"SnowLuma WebUI 不可达，请检查独立协议服务和启动日志"}
  snowluma.{mode:"local", proxySupported:false, tunnelPort:5099,
            diagnostics:{installed:false, version:"", state:"not-installed",
                         steps:["安装匹配架构的 SnowLuma 完整发行包"]}}
  desktop.{enabled:false, running:false}        ← server.desktopProxy=false
  orchestrator.{maxConcurrentRuns:1, pendingChats:0, backlogDeferred:true}
  qqPortable / usage / cost / cacheHitRate / paused / dataDir / peer
```

这正是计划第三节第 6 项要求的**状态拆分**（进程 / WebUI / Hook / 账号 / 协议），且把「连不上」翻译成用户能看懂的原因。

### 5.7 其余 API 冒烟

12 个常用接口带 cookie 全部 200：

```
/api/config  /api/instances  /api/panels  /api/logs  /api/chats  /api/onebot/accounts
/api/model-prices  /api/memory-files  /api/persona-templates  /api/deals
/api/market/accounts  /api/community/blocklist
```

未认证时对照全部 401。SSE `/api/events` 握手 `HTTP/1.1 200 OK` + `content-type: text/event-stream`。

### 5.8 数据落盘形态

```
event-inbox.sqlite(+shm/wal)     消息事件收件箱（SQLite WAL）
messages.sqlite(+shm/wal)        聊天存储（SQLite WAL）
session-summaries.sqlite(+shm/wal)  会话摘要
qq-agent.lock                    单实例锁
extensions/  logs/  sessions/
```

**关键：环境变量不落盘**——数据目录内**没有生成 `config.json`**，明文密码也不在任何文件中。这与计划「环境变量里的密钥不写回配置文件」完全一致。

### 5.9 优雅退出

```
SIGTERM → 退出码 0，停机 42 ms（另一轮实测 16 ms）
```

---

## 六、systemd 真实安装与组件托管

### 6.1 安装（`scripts/server/install-server.sh`，以 root 执行）

```
$ install-server.sh <ARCHIVE> /opt/qq-agent-wslverify /var/lib/qq-agent-wslverify kmy /usr/bin/node
服务器包校验通过：931 个文件，来源 2baf87a63189805d7f7e8f18d09941bd259fc5ce
Created symlink '/etc/systemd/system/multi-user.target.wants/qq-agent-server.service' → …
已安装核心版本：/opt/qq-agent-wslverify/releases/20261012144213-676
安装退出码 0，用时 7 秒
```

安装器内置的**归档安全解析**（`install-server.sh:90-111`，用 Node 手写 tar 头解析）逐条通过：checksum 校验、拒绝非普通文件（`type !== '0'`）、拒绝 `..` / 重复 / 反斜杠路径、强制要求存在 `server-manifest.json`。

### 6.2 安装结果与权限矩阵

| 对象 | 期望 | 实测 |
| --- | --- | --- |
| 数据目录 | 0750 | ✅ `drwxr-x--- 750 kmy:kmy` |
| `server.env` | 0600 root:root | ✅ `-rw------- 600 root:root` |
| `/etc/systemd/system/qq-agent-server.service` | 0644 root:root | ✅ |
| release 树 | `chmod -R a-w` + `chown root:root` | ✅ `-r--r--r-- 444 root:root`；**以服务用户 kmy 验证不可写** |
| 首启密码文件 | 0600 | ✅ `-rw------- 600 kmy:kmy` |
| `unit-state/` 快照 | 保留旧 unit | ✅ 与当前 unit 内容一致 |

`server.env` 内容（首次安装生成，`umask 077`）：

```
QQ_AGENT_MODE=server
QQ_AGENT_PRESET=server-2c2g
QQ_AGENT_DATA_DIR=/var/lib/qq-agent-wslverify
QQ_AGENT_PORT=3210
QQ_AGENT_BIND_HOST=0.0.0.0
# Set QQ_AGENT_PUBLIC_HOST to the public IP:port (for example 47.109.97.184:3210).
# First start creates DATA_DIR/console-initial-password.txt with mode 0600.
```

替换后的 unit 关键行：

```
ExecStart=/usr/bin/node /opt/qq-agent-wslverify/current/src/server.js
User=kmy  Group=kmy
ProtectSystem=strict   ProtectHome=read-only   PrivateTmp=true
ReadWritePaths=/var/lib/qq-agent-wslverify
Restart=on-failure  RestartSec=5s  TimeoutStopSec=20s
TasksMax=256  LimitNOFILE=8192   NoNewPrivileges=true
```

**`systemd-analyze verify` 无任何告警。**

### 6.3 托管行为实测

| 项目 | 实测 |
| --- | --- |
| `is-active` / `is-enabled` | `active` / `enabled` |
| 监听 | `0.0.0.0:3210` |
| 首启密码 | 生成 `console-initial-password.txt`（600，24 字符） |
| 首启会话 | `{"authenticated":false,"mustChangePassword":true,"environmentPassword":false}` |
| 用首启密码登录 | 200 `{"ok":true,"mustChangePassword":true}` |
| `Restart=on-failure` | kill -9 后自动拉起（MainPID 850 → 1359，`restart counter is at 1`） |
| `systemctl stop` | 退出码 0，**35 ms**，`inactive`，进程按 `KillMode=control-group` 回收 |
| 单实例锁 | 于回滚演练中由压测断言复核（见 §7） |

### 6.4 systemd 资源口径（权威统计）

```
MemoryCurrent=165.5 MiB    MemoryPeak=181.2 MiB
CPUUsageNSec=0.96 s        TasksCurrent=11   TasksMax=256
journalctl: Consumed 1.552s CPU time over 2min 27.891s wall clock time, 60.1M memory peak.
```

### 6.5 安装失败自动回滚演练（5/5 通过）

制造真实失败：**用占位进程占住 3210 端口**，使新核心因 `strictPort` 直接以 `EADDRINUSE` 退出。

```
$ node scripts/server/install-server.sh …
服务器包校验通过：931 个文件…
新核心健康检查失败，正在恢复旧核心版本；用户数据、QQ 和 SnowLuma 不会被修改。
安装已回滚：旧核心服务状态已恢复；若此前没有受管核心 unit，则没有启动任何旧桌面进程。
退出码=1  用时=27 秒
```

journal 记录的失败原因（同时印证 `strictPort` 生效——报错而非改端口）：

```
node[1300]: [启动失败] Error: listen EADDRINUSE: address already in use 0.0.0.0:3210
             code: 'EADDRINUSE', errno: -98, syscall: 'listen', port: 3210
systemd[1]: qq-agent-server.service: Failed with result 'exit-code'.
```

回滚结果核对：

| 检查项 | 结果 |
| --- | --- |
| `current` 指回旧版本 | ✅ `/opt/…/releases/20261012144637-648` |
| unit 文件 sha256 恢复为旧值 | ✅ `73ae412ef20e43e5…` 完全一致 |
| 服务状态恢复（此前 inactive） | ✅ 保持 `inactive` |
| 失败版本目录 | 保留（1 → 2 个），设计如此，便于排查 |
| **数据目录未被触碰** | ✅ `console-auth.json` 等原样保留 |

### 6.6 组件托管 socket（15/15 通过）

`polkit` 的替代方案——服务用户经固定 socket 请求 root 代为管理 3 个固定 unit。

生成并校验：

```
qq-agent-components.socket:
  ListenStream=/run/qq-agent-components/control.sock
  SocketUser=kmy  SocketGroup=kmy  SocketMode=0600  DirectoryMode=0755
  Accept=yes  MaxConnections=4  RemoveOnStop=yes

qq-agent-components@.service:
  User=root   StandardInput=socket   StandardOutput=socket
  ExecStart=/usr/bin/python3 …/component-broker.py
  RuntimeMaxSec=30s   ProtectSystem=strict   ProtectHome=true
  CapabilityBoundingSet=          ← 清空全部 capability
  RestrictAddressFamilies=AF_UNIX
```

`systemd-analyze verify` 两个 unit 均无告警。启用后：

```
srw-------  600  kmy:kmy  /run/qq-agent-components/control.sock
/run/qq-agent-components  drwxr-xr-x 755
```

请求矩阵（`component-broker.py` 只接受 `{kind, action}` **恰好两个键**，`kind` 限 `snow|qq|desktop`，`action` 限 `start|stop|restart`）：

| 请求 | 结果 |
| --- | --- |
| `{"kind":"snow","action":"start"}` | `{"ok": false, "error": "组件管理失败，请检查固定服务及管理员日志"}`（目标 unit 未安装，预期） |
| `{"kind":"snow","action":"status"}` | 同上（action 白名单外） |
| `{"kind":"snow","action":"start","extra":"x"}` | 同上（多字段） |
| `{"kind":"../../bin/sh","action":"start"}` | 同上（**路径穿越**） |
| `{"kind":"snow"}` / `not-json` / `[1,2,3]` | 同上 |
| 446 字节超长请求 | 同上 |
| **以 `nobody` 连接 socket** | `CONNECT_ERROR [Errno 13] Permission denied` |

**安全属性确认**：无任意命令执行面；所有异常统一返回同一句错误文本，**不泄漏内部细节**；socket 0600 使非服务用户无法连接。journal 显示每次连接正常触发 `qq-agent-components@N-…service（PID x/UID 1000）`，socket 激活机制工作正常。

---

## 七、2C2G 约束下的端到端压测

### 7.1 方法

用官方 `scripts/server/server-benchmark.mjs`（**不在 `npm test` 内**），在 cgroup 限制下运行，模拟 2C2G：

```bash
systemd-run --scope --unit=qqa-bench \
  -p MemoryAccounting=yes -p MemoryHigh=1600M -p MemoryMax=1900M -p CPUQuota=200% \
  --uid=kmy --gid=kmy --working-directory=$REPO \
  /usr/bin/node scripts/server-benchmark.mjs --output report.json
```

该压测是**真实的完整链路**：`createApp → 持久化 EventInbox → SQLite → orchestrator → model → OneBot`，协议端与模型端为本地 fixture（**不需要真实 QQ 账号**）。默认相位：5 事件/s × 10s，20 事件/s × 60s，随后 drain 与重复消息去重验证。

> 脚本自带前置断言（`server-benchmark.mjs:300`）：`mode !== 'server' || store.backend !== 'sqlite' || incoming.capacity !== 512` 即抛错——**压测过程本身就在校验 2C2G 预设**。

### 7.2 结果：`passed: true`，17/17 断言通过，`errors: []`

```
emitted           : {unique: 1250, duplicate: 5}
incoming          : {accepted: 1255, completed: 1255, failures: 0, rejected: 0,
                     deadletter: 0, pending: 0, processing: 0, count: 0}
archive           : {incoming: 1250, distinctProtocolKeys: 1250, duplicateRows: 0,
                     missingSourceKeys: 0, unread: 0,
                     5 组各 250（group:30001…30005）}
model             : {simulated: true, calls: 1250, delayMs: 10}   ← 5 条重复未调模型
protocol          : {replies: 1250, 5 组各 250}
elapsedSeconds    : 76.46
```

17 项断言全部 PASS：`realServerAndDurableInbox`、`sqliteChatStore`、`allEmittedEventsPersisted`、`allPersistedEventsCompleted`、`noRejectedOrDeadletterEvents`、`uniqueIncomingArchive`、`sourceKeysPersisted`、`allFiveGroupsArchivedAndReplied`、`duplicatesDoNotAppend`、`duplicatesDoNotCallModel`、`duplicatesDoNotSend`、`noUnreadAfterDrain`、**`runningLockRejectsContender`**、**`gracefulShutdown`**、`lockRemovedAfterStop`、`nextInstanceCanAcquireLock`、`consoleSamplingSucceeded`。

### 7.3 资源峰值

```
core（Node 进程自报）：
  rss         169.8 MiB      pss         139.9 MiB
  heapUsed     33.0 MiB      heapTotal    49.3 MiB
  external      6.49 MiB     arrayBuffers 2.09 MiB
  cpuPercent   40.42%（单核口径）
  eventLoop p99/max  54.56 ms      swapBytes  0
  停机        16.09 ms    退出码 0

cgroup 口径（含 harness 父进程 + core 子进程 + Workers）：
  memory.current 峰值  206.8 MiB      均值 177.1 MiB
  CPU 累计 25.57 s / 78.8 s 墙钟 → 平均 32.5% 单核
  cgroup 内进程/线程数峰值 29
```

### 7.4 与甲方 ECS 实机记录对比

| 指标 | ECS（i-2vc3qupw44r98d5you5e<br>2 vCPU / 1736 MiB / Ubuntu 22.04.5） | **WSL（200% CPU / 1.9G<br>Ubuntu 26.04）** |
| --- | --- | --- |
| 压测事件 | 1250 新 + 5 重复 | **完全相同** |
| 结果 | 全通过 | **17/17 通过** |
| PSS | 134.71 MiB | 139.9 MiB |
| RSS | 160.84 MiB | 169.8 MiB |
| heapUsed | 34.12 MiB | 33.0 MiB |
| external | 5.59 MiB | 6.49 MiB |
| CPU（单核） | 34.58% | 40.42% |
| 认证接口 p95 上界 | 20 ms | **10 ms** |
| 认证接口最大 | 15.74 ms | **7.89 ms** |
| 停机 | 23.99 ms | **16.09 ms** |
| Swap | 0 | 0 |
| 压测时长 | 71.87 s | 76.46 s |

**两个独立环境、不同发行版、不同内核、不同 Node 版本，资源峰值与延迟落在同一量级**，且 WSL 在受限 cgroup 下**峰值内存仅 206.8 MiB**（含测试 harness），远低于 2C2G 的约 1.7 GiB 可见内存预算——**没有 OOM 风险，也没有 swap 使用**。

---

## 八、发现与建议

### 8.1 唯一新增的实质发现：SQLite WAL/SHM 文件权限不一致（低危）

**现象**（在裸启动与 systemd 安装两种路径下均复现）：

```
600  messages.sqlite           ← 主库正确
644  messages.sqlite-shm       ← 沿 umask 0022
644  messages.sqlite-wal       ← 含尚未 checkpoint 的近期消息数据
644  session-summaries.sqlite  ← 主库也是 644
644  session-summaries.sqlite-shm / -wal
600  event-inbox.sqlite / -shm / -wal   ← 该模块做对了
```

**根因**（源码比对）：

| 文件 | 行为 |
| --- | --- |
| `src/event-inbox.js:78` | `for (const file of [db, db-wal, db-shm]) fs.chmodSync(file, 0o600)` ✅ 三个文件全覆盖 |
| `src/sqlite-store.js:86` | `if (file !== ':memory:') fs.chmodSync(file, 0o600)` ❌ **只处理传入的主库，未覆盖 `-wal`/`-shm`**，且 `session-summaries` 主库亦未生效 |

**影响评估（诚实降级）**：默认部署下**不可利用**——`install-server.sh:24` 以 `install -d -m 0750` 创建数据目录，owner/group 之外的用户无法进入目录，`0644` 在目录级已被挡住。风险仅存在于以下条件同时成立时：目录权限被管理员放宽（如 0755）、或 `QQ_AGENT_DATA_DIR` 指向共享目录、或同组存在其他用户。

**性质**：属**纵深防御层面的不一致**（同一项目内两个模块做法不同），而非可利用漏洞。

**建议**（不改动现有行为，仅对齐）：在 `src/sqlite-store.js` 中把 chmod 扩展到 `-wal` / `-shm`，与 `event-inbox.js` 保持一致。注意：`-wal`/`-shm` 在运行期由 SQLite 创建，需在打开数据库后（WAL 生效后）再次 chmod，或在 `close()`/checkpoint 后补一次。

### 8.2 已验证但值得记录的正面确认

| 项 | 证据 |
| --- | --- |
| 构建**跨发行版 + 跨 Node 补丁版**确定性 | WSL(26.04/22.22.1) 与 CI(22.04/22.17.1) 载荷 929/930 逐字节相同 |
| 安装器**归档解析防路径穿越** | 手写 tar 头校验 + 拒绝非普通文件/`..`/重复路径 |
| release 树**真只读** | `444 root:root`，以服务用户实测不可写 |
| 失败**自动回滚且不动数据** | `current`+unit sha256 精确复原，`console-auth.json` 原样 |
| 组件管理**无任意命令执行面** | 6 类畸形请求（含 `kind` 路径穿越）全部统一拒绝 |
| 环境变量**不落盘** | server 模式下数据目录内无 `config.json`，明文密码不入盘 |
| `strictPort` 生效 | 端口冲突时报 `EADDRINUSE` 退出，而非静默改端口 |
| 单实例锁 | 压测断言 `runningLockRejectsContender` + 停机后 `nextInstanceCanAcquireLock` |

### 8.3 本次验收自身的方法学纠正（如实记录）

两处最初判定为 FAIL，复核后确认**是我的验证脚本缺陷，非被测对象问题**：

1. **`CURL="curl -sS --noproxy *"` 变量未加引号**，`*` 被 shell glob 展开为当前目录文件列表，导致 curl 参数错乱走代理，返回一串 `502`。修正为函数形式 `curl -sS --noproxy '*'` 后全部 200。
2. **以 root 身份测试 release 只读性**——root 无视 `0444` 权限位，`touch` 成功不代表可写。改用 `runuser -u kmy` 验证 → 正确反映"不可写"。

---

## 九、限制与未做项

**本报告明确未做**：

- ❌ 未连接 `47.109.97.184` ECS，未登录、未部署、未重启任何线上服务。
- ❌ **未做真实 QQ 扫码登录 / SnowLuma 一收一发**——需真实账号与人工扫码，WSL 与 ECS 均无法代做。
- ❌ **未做 24 小时持续稳定性验收**——压测脚本的 `limitations` 亦明确声明「Short runs do not establish 24-hour stability」。本报告仅证明 ~78 秒满载相位无泄漏、无 OOM、无 swap。
- ❌ 未测 `api.videoMode` 真实视频生成（预设为 `off`）。
- ❌ 未配置真实模型 API / 模型名（保持未配置状态）。
- ❌ `qqagent-fedora` 发行版损坏未使用；WSL 未模拟 2 核的**物理**CPU 频率差异。

**被测对象的既有局限（引自压测脚本自身声明）**：

- QQ、SnowLuma、Xvfb 与付费模型provider 为模拟或缺失，其资源占用与真实投递未被计量。
- Node heap/external 指标仅描述主 isolate；core RSS 与 Linux PSS 包含其 Workers。
- 控制台延迟为认证后的 loopback HTTP 测量；event-loop p99/max 为累计计数器；直方图百分位为上界值。

**WSL 与真实 ECS 的差异（影响解读）**：

- WSL2 内核为微软定制内核，cgroup 与 I/O 调度与裸机 Linux 不同；磁盘为虚拟盘（`/dev/sdd`）。
- 本机 Node 为 v22.22.1 / v22.23.2，而清单 `runtime.validatedNode` 为 **22.17.1**；已通过构建确定性间接证明补丁版本不敏感。

---

## 十、复现方式

工作区：`/home/kmy/qqa-wsl-verify/`（WSL 内）；辅助脚本：`qqa/_tools/wsl/`（Windows 侧，经 `/mnt/c` 调用）。

| 脚本 | 作用 |
| --- | --- |
| `probe.sh` | 环境探测（工具链、systemd、网络） |
| `01-clone.sh` | clone 远端分支 + 行尾核对 |
| `02-deps-test.sh` | `npm ci` + `npm test`（完整套件） |
| `03-build.sh` | 官方脚本构建 + `verify-release.mjs` 自校验 |
| `04-crosscheck.sh` | WSL / CI / 甲方包三方逐文件比对 |
| `05-eol-attribution.py` | 行尾差异归因 |
| `06-smoke.sh` | 服务端到端冒烟（21 项） |
| `07-routes.sh` | 路由 / 重定向 / 预设 / SSE 探测 |
| `08-status.sh` | `/api/status` 状态诊断 + 12 个 API 冒烟 |
| `09-systemd.sh` | 真实安装 + systemd 托管验收 |
| `10-rollback.sh` / `11-rollback.sh` | 补充验证 + 安装失败回滚演练 |
| `12-bench.sh` | cgroup 限制下的端到端压测 |
| `13-components.sh` + `component-client.py` | 组件托管 socket 验收 |

调用形式（Git Bash）：

```bash
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash /mnt/c/…/_tools/wsl/<脚本>.sh
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -u root -- bash /mnt/c/…/_tools/wsl/<脚本>.sh   # 需 root 的
```

> 两个非显然的要点：① `wsl.exe` 传参时 Git Bash 的 MSYS 会把 `/mnt/c/...` 当 Windows 路径转换，必须加 `MSYS_NO_PATHCONV=1`；② WSL 内的 `curl` 会继承宿主代理环境变量，访问 loopback 必须 `--noproxy '*'`。

**贯穿性工作产物**：`_results/wsl-*.log`（环境、测试、构建、比对、冒烟、路由、状态、systemd、回滚、组件、压测）与 `_results/wsl-benchmark.json`（压测完整报告）。

---

## 附录：关键数据汇总

| 对象 | 值 |
| --- | --- |
| 被测 commit | `2baf87a63189805d7f7e8f18d09941bd259fc5ce` |
| 源码 `package.json` | `cb6248f90ee5524177a41ef9fbf4c3f70c559aefd9247d7d8bf8bd451d7ea322` |
| 源码 `package-lock.json` | `3f03d92a2eba47d4810c2c76a243dcbdd6e434029939d550531b3b4f2284c904` |
| 甲方已部署包（= Windows 复现 C1） | `f10e150c864f23e131fe5e9bf40a36644fe97f95bf3892776428a9493ae62789` |
| GitHub CI 构建 | `121014c73d6c0a40c04a9350742b276a23d28ac2517f889cc0f7bb0e7e25ed8a` |
| **WSL 构建** | **`a11d029c03bd878404884820335fdd2be1a3ac4d64d43d42cda6d2809bb1fa18`** |
| WSL Node | `/usr/bin/node` v22.22.1（清单 `validatedNode` 为 22.17.1） |
| WSL systemd | 259 (259.5-0ubuntu3.4) |
