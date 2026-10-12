# QQA Linux 服务器适配（2 核 2G）—— 本地验收报告

| 项目 | 内容 |
| --- | --- |
| 验收对象 | 甲方参考实现（`codex/server-2c2g` 工作树）＋ 已部署服务器包 |
| 验收依据 | `I:/server-2c2g-plan.md`（甲方计划）、`docs/server-2c2g-{plan,implementation,review}.md` |
| 验收范围 | **仅本地**：源码完整性、静态校验、测试套件、发布包重建与可复现性 |
| 明确排除 | **不连接 `47.109.97.184` ECS，不做任何线上部署、重启或变更** |
| 验收日期 | 2026-10-12 |
| 本地源码基线 | `C:/Users/kmy/WorkBuddy/2026-10-12-13-59-08/qqa/repo`（= 样本 `QQA/源码/`） |

> **路径与称谓约定**（本报告后来入库到 `docs/`，故说明一次）
>
> - 报告产出于工作区 `qqa/`：**仓库本体**在 `qqa/repo/`；验证产物在 `qqa/_results/`；本轮辅助脚本在 `qqa/_tools/`；样本解包件在 `qqa/_pkgcheck/`。
>   文中的 `_results/`、`_tools/`、`_pkgcheck/` 均为**工作区验证产物，不随本仓库入库**（符合 `.gitignore` 的「构建产物绝不入库」约定）。
> - 文中「**甲方参考实现**」指本仓库 `codex/server-2c2g` 分支的工作树（基线 `da6f056` ＋ 316 条未提交改动），以及由它构建出的服务器包。该分支**零提交**，全部工作为工作树状态，故 `server-manifest.json` 记 `"dirty": true`。

---

## 一、结论摘要

| 结论 | 判定 |
| --- | --- |
| 源码基线可追溯（提交号 / 脏工作树 / epoch / 依赖锁全部对齐） | ✅ 通过 |
| 静态校验（JS 语法、Shell 语法、依赖图完整性） | ✅ 138/138、74/74、0 缺失 |
| 测试套件结构（用例总数、Linux 专项跳过数）与参考实现完全一致 | ✅ 123 项 / 跳过 5 项 |
| 测试套件通过率 | ⚠️ 116 通过、**2 失败**（已定位为 Windows 时序容差，非功能缺陷） |
| 发布包可重建、可自校验 | ✅ 官方 `verify-release.mjs` 通过 |
| **发布包逐字节可复现** | ✅ **成功复现甲方已部署包 SHA256 `f10e150c…`** |
| 计划第 3 节 15 项改造 | ✅ 15/15 有源码实现证据 |
| 计划第 5 节预设与资源策略 | ✅ 已实现（2 处偏差甲方已书面说明） |
| 计划第 7 节 10 类验收 | ✅ 8 类本地/记录可证；1 类部分（SnowLuma 实机需本人操作）；**1 类未做（24 小时稳定性）** |
| 24 小时持续稳定性验收 | ❌ **未做**（甲方亦标注待办） |

**一句话结论**：甲方参考实现在本地可完整复现——不仅源码可校验、测试可运行，**连已部署的生产服务器包都能从样本源码逐字节重新构建出来**（SHA256 完全一致）。唯一未闭合项是 24 小时持续稳定性验收，属需要长时间挂机且依赖真实 QQ 的项，本轮不做。

---

## 二、基线与可追溯性核验

### 2.1 源码基线

| 检查项 | 结果 |
| --- | --- |
| `git rev-parse HEAD` | `da6f0560c1c7530a985bb4c1542a88cae104b80e` |
| 分支 | `codex/server-2c2g`（**零提交**，全部工作为未提交的工作树状态） |
| `git show -s --format=%ct HEAD` | `1791356893` |
| 工作树改动条数 | **316** |
| 与清单 `source.changes` 条目集合 | **316 vs 316，逐条一致** |
| 清单 `source.dirty` | `true` |

### 2.2 服务器包哈希链（三方交叉验证）

| 来源 | SHA256 |
| --- | --- |
| 实际计算 `qq-agent-server-v0.4.7-node22.tar.gz` | `f10e150c864f23e131fe5e9bf40a36644fe97f95bf3892776428a9493ae62789` |
| 随包 `.sha256` 文件 | 同上 |
| `部署资料/server-deployment-20261012.md` 记录 | 同上 |

**三方完全一致。** 体积 4,007,495 字节。

### 2.3 `server-manifest.json` 逐条核验

| 检查项 | 结果 |
| --- | --- |
| 清单条目数 | 929 |
| 包内实际文件数 | **930** = 929 + manifest 自身 |
| 逐条 SHA256 比对 | **929/929 全部吻合**（大小亦全部吻合） |
| 包内未登记文件 | 0（除 manifest 自身） |
| 清单缺失文件 | 0 |
| 与 `目录整理记录.json` 的 `archiveEntriesVerified` | 930 ✅ 一致 |
| 与仓库文档「重新构建的 **930** 文件归档已上线」 | ✅ 一致 |
| `source.packageSha256` vs 实际 `package.json` | ✅ `cb6248f9…` 一致 |
| `source.lockSha256` vs 实际 `package-lock.json` | ✅ `3f03d92a…` 一致 |
| `source.epoch` vs `git show -s --format=%ct HEAD` | ✅ `1791356893` 一致 |
| `file` 模式位 | 925 个 `0644` + 4 个 `0755`（4 个 `.sh`），与构建脚本规则一致 |

### 2.4 包内业务文件 vs 源码树

| 检查项 | 结果 |
| --- | --- |
| 非 `node_modules` 条目 | 148 |
| 与 `repo/` 源码逐字节一致 | **143** |
| 不一致 | 5 |
| 源码中不存在 | 0 |

5 处不一致的定性：

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `package.json` | **预期（构建期裁剪）** | `main`→`src/server.js`、`scripts`→`{start,server}`、删 `devDependencies` 与 `build`(electron-builder)。由 `scripts/build-server.mjs` L118-120 实现，**重建时逐字节复现**（见第五节） |
| `docs/server-2c2g-implementation.md` | **预期（打包后文档修订）** | 源码侧 17,552 B > 包内 16,839 B；源码侧含「新版已切换生产并验证」「930 文件归档已上线」等**部署后**结论 |
| `docs/server-2c2g-plan.md` | 同上 | 23,116 B > 22,856 B |
| `docs/server-2c2g-review.md` | 同上 | 10,063 B > 9,140 B |
| `docs/server-install.md` | 同上 | 7,398 B > 6,989 B |

**这 4 个文档的差异是预期行为，不是缺陷。** 甲方 `目录说明.md` 已明确记载：

> 「本次整理只移动文件并修正文档路径，**不重新构建或重启服务器**」

即：包在文档修订**之前**构建，源码树保留了修订**之后**的定稿。差异内容全部是路径修正（`validation/` → `构建产物/验证记录/`）与部署结果补记，不涉及任何代码或行为。

---

## 三、静态校验

| 校验项 | 结果 |
| --- | --- |
| JS / MJS / CJS 语法（`node --check`） | **138 / 138 通过，0 失败** |
| Shell 语法（`bash -n`） | **74 / 74 通过，0 失败** |
| `scripts/server/*.sh` 专项 | 4 / 4 通过 |
| 依赖图完整性（官方 `scripts/verify-no-missing-requires.mjs`） | 扫描 439 个 JS 文件，**解析不到的相对 require = 0** |

> 说明：扫描数 439 包含恢复后的 `node_modules`；不含依赖时为 137。两种口径下缺失数均为 0。

---

## 四、测试套件结果

### 4.1 总体

执行 `npm test`（官方 `package.json` 中串联的 18 个测试文件），耗时 **8 分 32 秒**。

| 指标 | 本地实测 | 参考实现（Windows） | 参考实现（ECS Linux） |
| --- | --- | --- | --- |
| `# tests` | **123** | 123 | 123 |
| `# pass` | 116 | 118 | 123 |
| `# fail` | **2** | 0 | 0 |
| `# skipped` | **5** | 5 | 0 |
| 退出码 | 1 | 0 | 0 |

**用例总数与跳过数完全一致**，说明套件结构复现无误；差异仅在 2 个失败项。

### 4.2 跳过项（5 项，全部为 `process.platform !== 'linux'`）

| # | 用例 |
| --- | --- |
| 14 | root component broker rejects malformed or arbitrary operations before systemctl |
| 15 | SnowLuma launcher runs through a current release symlink and captures the initial password |
| 80 | failed installer restores only managed core release/unit/status, and fresh installs stay stopped |
| 81 | installer validates quoted or invalid ports before switching the managed core |
| 82 | manual rollback restores unit/runtime and recovers an unhealthy prior core |

跳过原因均为这些用例显式要求 Linux（polkit / systemd / 符号链接语义）。**与参考实现记录的「Windows 5 个 Linux 专项跳过」逐项对应。**

### 4.3 失败项（2 项）——已定位为 Windows 时序容差，非功能缺陷

两项均在 `test/event-inbox-test.mjs`，且都是**墙钟时间容差断言**：

| # | 用例 | 失败断言 |
| --- | --- | --- |
| 25 | recovers a processing row left by a crashed worker | `close({deadlineMs:20})` 应 < 500 ms（源码 L156） |
| 29 | close deadline returns promptly while an uncooperative handler is active | `close({deadlineMs:25})` 应 < 500 ms（源码 L242） |

**归因证据（三重）：**

1. **单独复跑该文件：13/13 全部通过**，包括上述 2 项。
   ```
   # tests 13 / # pass 13 / # fail 0 / # skipped 0 / duration_ms 13076
   ```
2. **实测 `close({deadlineMs:25})` 的空载耗时**（本机 10 次采样）：
   ```
   119.5, 126.2, 128.0, 128.3, 140.0, 149.2, 159.4, 175.2, 185.4, 245.4  (ms)
   最小 119.5 | 中位 149.2 | 最大 245.4
   ```
   → Windows 上 SQLite WAL 关闭的**基线耗时约 150 ms**，而断言容差是 500 ms，**只有约 2–3 倍余量**。
3. 完整套件在 2 vCPU 上并行跑 18 个文件，同时存在 10 万条消息迁移、`npm ci` 等重负载，`close()` 超过 500 ms 属预期。

**结论**：这是测试容差对 Windows 过于严苛导致的偶发失败，不是 `EventInbox` 的功能缺陷。甲方 Windows 机器上 0 失败，说明在更快的机器上可过。

**建议**：把这两处容差从固定 500 ms 放宽（例如按平台取 2000 ms），或将 `event-inbox-test.mjs` 标记为不与其他重负载文件并行执行。这不影响 Linux 生产环境（ECS 上 123/123 通过）。

### 4.4 构建相关测试（重点，全部通过）

| # | 用例 | 结果 |
| --- | --- | --- |
| 78 | server artifact uses current source/exact lock, omits desktop and private state, and detects tampering | **ok**（含 `buildServer()` 端到端 + 篡改检测） |
| 79 | archive metadata and compression reproduce independently of source file mtimes | **ok**（归档确定性） |

---

## 五、发布包重建与可复现性（本轮核心结论）

### 5.1 实验设计

| 编号 | 输入 | 目的 |
| --- | --- | --- |
| **B1** | 当前基线源码（`repo/`），文档为**源码侧定稿版** | 从当前基线重建，产出可交付的新包 |
| **B2** | 同 B1 | 验证**构建确定性** |
| **C1** | 同 B1，但把 4 个 `docs/server-*.md` 换回**包内版本** | 验证能否**逐字节复现甲方已部署包** |

### 5.2 结果

| 编号 | 归档 SHA256 | 字节 | 文件数 |
| --- | --- | --- | --- |
| **B1** | `5808147ac1ad34bbb0c7e75a56f0312c6a4e9f507d04b696acffe52cca47603a` | 4,007,906 | 930 |
| **B2** | `5808147ac1ad34bbb0c7e75a56f0312c6a4e9f507d04b696acffe52cca47603a` | 4,007,906 | 930 |
| **C1** | **`f10e150c864f23e131fe5e9bf40a36644fe97f95bf3892776428a9493ae62789`** | 4,007,495 | 930 |
| 甲方已部署包 | `f10e150c864f23e131fe5e9bf40a36644fe97f95bf3892776428a9493ae62789` | 4,007,495 | 930 |

**两个决定性结论：**

1. **B1 == B2** → 构建是**确定性的**：同源码、同 epoch 两次独立构建产出完全相同的归档。
2. **C1 == 甲方已部署包（SHA256 与字节数完全一致）** → 发布包**逐字节可复现**。仅需把 4 个在打包后被修订的文档还原为包内版本，其余一切（含 `package.json` 的构建期裁剪、929 个文件的内容、tar 头、gzip 流）都由官方脚本原样重建出来。

### 5.3 B1（当前基线重建包）与甲方包的差异

| 检查项 | 结果 |
| --- | --- |
| 清单条目覆盖 | 929 / 929，无缺失、无多余 |
| 逐文件一致 | **925** |
| 逐文件不同 | **4**（正是那 4 个文档，原因见 2.4） |
| `source.commit` / `dirty` / `epoch` | ✅ 完全一致 |
| `source.packageSha256` / `lockSha256` | ✅ 完全一致 |
| `runtime` 块（minimumNode / validatedNode / mode / preset / bundledNode / bundledProtocol） | ✅ 逐字段一致 |
| 官方 `verify-release.mjs` 自校验 | ✅ 通过（930 个文件） |

即：**B1 与甲方包的全部差异都在预期内，且仅限 4 个文档的文本内容。**

### 5.4 关于 `source.changes` 首行少一个空格的解释

甲方清单中 `source.changes[0]` 为 `"M README.md"`，而 `git status --porcelain=v1` 对未暂存文件输出 `" M README.md"`（带前导空格）。经实测确认，**这不是清单被篡改，而是构建脚本的确定性行为**：

`scripts/build-server.mjs` 的 `run()` 在返回前对 stdout 调用了 `.trim()`：

```
git 原始首行      : " M README.md"
build-server 之后 : "M README.md"
条数 原始/trim    : 316 / 316
```

由于 `README.md` 按路径排序恰为**第一行**，其前导空格被 `.trim()` 剥掉；其余 315 行不受影响。该行为在重建时**逐字节复现**（C1 内嵌 manifest 同样是 `"M README.md"`）。

**影响评估**：纯属元数据外观问题，不影响任何文件内容、校验或运行行为。若希望清单与 `git status` 逐字一致，可把 `run()` 的 `.trim()` 改为 `.replace(/\r?\n$/, '')`（仅去除行尾换行），但**不建议为此改动**——它会让已部署包的哈希失效。

### 5.5 附注：Node 版本差异未影响复现

本地使用 Node **22.22.2**（managed），而清单 `runtime.validatedNode` 为 **22.17.1**。两者下仍复现出同一归档哈希，说明**归档生成对 Node 补丁版本不敏感**（tar 头由脚本显式构造、gzip 未写入时间戳、压缩级别固定为 9）。

---

## 六、计划逐条对照

### 6.1 第 3 节「已确认需要修改的地方」（15 项）

| # | 待改项 | 判定 | 实现证据 |
| --- | --- | --- | --- |
| 1 | 发行包仍以 Electron 为主 | ✅ | `src/runtime.js#isServerMode()`（`QQ_AGENT_MODE=server`，由 `src/server.js` L2 设置）；`scripts/build-server.mjs` L126 禁止名单含 `electron`；包内 `node_modules` 无 electron |
| 2 | 只监听回环、来源验证只接受本机 | ✅ | `src/runtime.js` L34-36 环境变量覆盖、L48 `sameOriginAllowed()`；`src/app.js` L1947 `bindHost`、L1629 来源检查 |
| 3 | 端口冲突自动改 3211 | ✅ | `src/app.js` L1963-1966：`strictPort` 时循环上界为 1，冲突即明确失败；`runtime.js` L10 预设 `strictPort:true` |
| 4 | `server.token` 无法支撑完整浏览器流程 | ✅ | 新增 `src/console-auth.js`（scrypt + HttpOnly/SameSite=Strict Cookie + 8h TTL + 5 次失败锁 15 分钟 + 环境变量密码模式 + 改密失效全部会话）；`src/app.js` L1790 统一入口，L1795/L1801/L1810/L1821 未授权一律 401 |
| 5 | SnowLuma WebUI 在服务器执行 `xdg-open` | ✅ | `src/snowluma-proxy.js`（无 xdg-open）；`src/routes.js` L148 服务器模式返回 `/snowluma/` 入口，不支持代理时明确回退 SSH 本地转发（L150 `tunnelPort`） |
| 6 | 端口未开被诊断成未登录；探测固定回环 | ✅ | `src/protocol-diagnostics.js#diagnoseSnowluma()`：拆出 `installed / version / hookAutoLoad / mustChangePassword / accountConfigCount / ptraceScope / steps / state`，`state ∈ not-installed \| setup-required \| configuration-present`；外部协议端探测走 `protocolEndpoint()` |
| 7 | 启动成功仅表示已 spawn 或端口被占用 | ✅ | `src/app.js#snowlumaStatus()`：服务器模式查 systemd 组件实际状态 + 按**真实命令行**匹配进程（含 `index.mjs` 路径），不再以「端口是否打开」推断 |
| 8 | SnowLuma 停止接口未 await | ✅ | `src/routes.js` L388-392 `/api/snowluma/stop` → `await stopSnowluma()`；`src/app.js` L477 `stopSnowluma()` 返回真实结果 |
| 9 | Headless 入口仅注册 SIGINT | ✅ | `src/server.js` L17 `['SIGINT','SIGTERM']`；L7 `stopping` 保证幂等；L8 15 秒兜底；L18 处理 `uncaughtException`/`unhandledRejection` |
| 10 | 聊天数据全量常驻、同步重写整群 JSON | ✅ | `src/sqlite-store.js`（SQLite WAL，`DEFAULT_QUERY_LIMIT=2000`）、`src/storage-json-stream.js`（流式读取，单记录上限）、`src/storage-worker.js` / `storage-maintenance.js` 隔离重活 |
| 11 | 启动即扫描用量档案 | ✅ | `src/usage-index.js`（持久化索引，按区间增量刷新）、`src/usage-service.js`；`src/app.js` L1992 / L2109 服务器模式下跳过预热；`runtime.js` 关闭 `background.usageWarm` |
| 12 | 扩展加载仍会导入入口、默认开热重载 | ✅ | `runtime.js` L11 `extensions.hotReload=false`；`src/plugin-loader.js` L45 `EXTENSIONS_DIR = DATA_DIR/extensions`；L366 无 `setup/hooks/providers/activate` 才跳过；L386-422 完整 `deactivate`→`activate` 生命周期 |
| 13 | 记忆整理 / 插件 Worker / 媒体各自为政 | ✅ | `src/task-queue.js`、`src/bounded-work.js`、`src/media-resources.js`、`src/event-inbox.js`；全部由 `cfg.resources.*` 接线（`app.js` L176-178、`memory.js` L160、`sender.js` L82、`sessions.js` L207） |
| 14 | 部分功能依赖 Electron 或本地计算 | ✅ | `runtime.js` L17 `api.videoMode='off'`；`src/media-process.js` 子进程限时；`runMediaProcess` 并发 1；服务器包不含 Electron；帮助/菜单走控制台文本路径 |
| 15 | CI 的应用代码来自旧归档 | ✅ | `.github/workflows/server.yml`：`ubuntu-22.04` + Node `22.17.1` → `npm ci --omit=dev --omit=optional --ignore-scripts` → `npm test` → `npm run build:server` → 官方 `verify-release.mjs` + `verify-no-missing-requires.mjs` → 上传 artifact |

### 6.2 第 5 节「2C2G 预设与资源优化」

**配置优先级**（`src/config.js`）：
- `loadConfig()` L496：`deepMerge(deepMerge(DEFAULT_CONFIG, runtimeDefaults()), migrateLegacySkills(parsed))`
- `getEffectiveConfig()` L581：再叠 `applyEnvironment()`
- `updateConfig()` L670-671：**先校验再写盘**；L640-644 的 `envPaths` 表把环境变量已覆盖的键从 patch 中剔除 → **密钥不落盘** ✅ 与计划一致

**预设项对照**（`src/runtime.js` L9-24）：

| 计划策略 | 预设值 | 判定 |
| --- | --- | --- |
| QQ 账号默认 1 个 | 部署形态为单 SnowLuma 实例 + 单核心；代码保留多账号识别与轮换 | ✅ 以部署形态满足（无独立配置项） |
| Agent 并发 `maxConcurrentRuns=1` | `maxConcurrentRuns: 1` | ✅ |
| 待运行群队列上限 32 | `maxPendingChats: 32` | ✅ |
| 记忆整理共享限流、低优先级 | `memory.consolidateEnabled: false` + 统一队列 | ✅ |
| 热重载关闭 | `extensions.hotReload: false` | ✅ |
| MongoDB 关闭自动自举 | `background.mongoAutoStart: false` | ✅ |
| 用量禁止启动全量预热 | `background.usageWarm: false` + `usageCacheSessions: 256` | ✅ |
| 主动找聊 / 定时扫描默认关闭（提醒保留） | `proactive.enabled: false`（`app.js` L2100 门控） | ✅ |
| 本地语音识别默认关闭 | 本地 whisper 模块已随 bundled 模块移除，仅保留可选远程路径 | ✅ |
| 视频默认元信息模式 | `api.videoMode: 'off'` | ✅ |
| 图片能力设上限 | `mediaMaxBytesMB: 8`、`mediaConcurrency: 1`、`mediaCacheMB: 64` | ✅ |
| Electron 图片菜单→文本 | 服务器包无 Electron，控制台走文本路径 | ✅ |
| 插件与 Skill 仅启用才执行 | `extensions/` 用户目录 + 市场安装；禁用不执行 setup | ✅ |
| 日志按天与总字节滚动 | `src/logger.js` L22-23：`MAX_FILE_BYTES=8MiB`、`MAX_TOTAL_BYTES=64MiB` | ✅ |
| 媒体缓存 TTL 与容量 | `mediaCacheMB: 64`、`mediaCacheTtlMs: 86400000` | ✅ |
| 其他资源上限 | `incomingQueue:512`、`incomingConcurrency:1`、`sendQueuePerChat:64`、`maxOnebotPayloadMB:4`、`memoryCacheChats:32`、`localMedia:false` | ✅ |
| 服务器绑定 | `bindHost:0.0.0.0`、`strictPort:true`、`auth:true`、`maxSseClients:8`、`desktopProxy:false` | ✅ |

**与甲方原计划的 2 处偏差**（甲方已书面记录，非缺陷）：

| 项 | 甲方原计划 | 参考实现 | 说明 |
| --- | --- | --- | --- |
| Node 基线 | 「候选基线为 **Node 24 LTS**，需先验证依赖与存储驱动」 | 固定 **Node 22.17.1**（最低 22.16） | 文档写明为实测后收敛的结论 |
| 插件与 Skill | 「**不直接删除**扩展，也不把『默认禁用』当成永久取消」 | **删除仓库内全部 bundled 模块**，保留核心框架与 Skill 市场，用户自行装到数据目录 | 文档注明「**按用户后续要求**」 |

### 6.3 第 7 节「验收方法与依赖」（10 类）

| # | 验收范围 | 本地可验证性 | 判定 |
| --- | --- | --- | --- |
| 1 | 无桌面运行 | 包内无 Electron ✅；`npm test` 中 `server-test` / `app-integration` 在无 DISPLAY 下通过 | ✅ 通过 |
| 2 | 远程访问（3210 登录、未认证拒绝、SSE/媒体/下载同一认证、错误来源拒绝） | `console-security-test.mjs` 通过；`console-auth.js` 覆盖 SSE/媒体/下载统一认证 | ✅ 通过 |
| 3 | 服务生命周期（SIGTERM 保存退出、端口冲突明确失败、单实例锁） | `instance-lock-test.mjs` 通过；`server.js` + `app.js` L1963-1966 | ✅ 通过 |
| 4 | OneBot 兼容（mock WS+HTTP、令牌、重连、外部地址、负数消息 ID） | `protocol-server-test.mjs` / `app-integration-test.mjs` 通过 | ✅ 通过 |
| 5 | SnowLuma 实机（WebUI 配置、Hook、QQ 登录、账号端点、一收一发） | 需真实 QQ 扫码与本人操作 | ⚠️ **部分**：甲方已验登录/首次设置页面；**Hook 与真实一收一发待本人完成** |
| 6 | 数据兼容（迁移前后一致、中断可恢复、回滚保留新数据） | `storage-test.mjs` 13/13 通过，含 10 万条消息迁移、中断迁移保持 JSON 不变 | ✅ 通过 |
| 7 | 扩展（禁用不执行 setup、无 Electron 可用、缺依赖原因可见） | `extensions-server-test.mjs` 通过 | ✅ 通过 |
| 8 | 低资源负载（2 vCPU / ~1736 MiB；5 条/秒 + 20 条/秒突发 60 秒） | 依赖 ECS 实测记录；本地为 2 vCPU 但环境不同 | ✅ **甲方实测已通过**：71.87 秒，1250 新 + 5 重复全部持久接收；核心峰值 PSS 134.71 / RSS 160.84 MiB、heapUsed 34.12、external 5.59 MiB、Swap 0、CPU 34.58% 单核；认证接口 p95 上界 20 ms（最大 15.74 ms）；停机 23.99 ms、退出码 0 |
| 9 | 大历史与慢客户端（10 万条、5000 会话、慢 SSE 有界） | `storage-test` / `usage-service-test` / `sessions-ui-test` 通过；含 5000 会话索引不阻塞 HTTP | ✅ 通过 |
| 10 | 持续稳定性（≥24 小时 PSS/RSS/CPU/事件循环/队列/Swap/磁盘/OOM） | 需长时间挂机 + 真实 QQ | ❌ **未做** |

**第 8 项资源目标的达标情况**（对照 5.3 节「第一轮验收预算」）：

| 指标 | 目标 | 甲方实测 | 判定 |
| --- | --- | --- | --- |
| 核心 + Worker 正常负载 PSS | ≤256 MiB | 134.71 MiB | ✅ 达标 |
| 控制台接口 P95 | <500 ms | 上界 20 ms | ✅ 达标 |
| 24 小时无 OOM/重复回复/缓存增长 | — | 未测 | ❌ 未验收 |
| 全机合计 PSS ≤1000 MiB、MemAvailable ≥256 MiB | — | 未在未来记录中给出 | ⚠️ 未见数据 |

---

## 七、发现的问题与建议

| 级别 | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| 中 | `test/event-inbox-test.mjs` 的 2 处 500 ms 墙钟容差在 Windows 并发下不稳（本机基线 ~150 ms，仅约 2–3 倍余量） | 本地测试偶发失败，易被误判为功能缺陷 | 按平台放宽容差（如 Windows 2000 ms），或该文件不与其他重负载文件并行 |
| 低 | `build-server.mjs` 的 `run()` 对 git stdout 调用 `.trim()`，导致 `source.changes[0]` 前导空格被剥掉 | 仅元数据外观；清单与 `git status` 不逐字一致 | 可改为仅去行尾换行；但会改变已部署包哈希，**不建议现在改** |
| 低 | 发布包内 4 个 `docs/*.md` 落后于源码树定稿 | 包内文档缺少部署结果补记与路径修正 | 下次构建自然收敛；无需单独处理 |
| 提示 | 24 小时稳定性验收尚未完成 | 无法宣称长期稳定 | 需在真实 QQ 登录后另行安排长时间挂机 |

---

## 八、本机环境限制与验证手段的诚实声明

本轮验收在此环境下遇到一处硬限制，并做了**可验证的等价处理**，特此声明：

**限制**：本机 `node.exe` **无法使用 `child_process` 的同步 API**——`spawnSync` / `execSync` / `execFileSync` 一律返回 `EBUSY`（在关闭沙箱后同样如此，属机器级限制，非沙箱策略）；但**异步 `spawn` 完全正常**。`npm ci` 之所以能运行，是因为 `--ignore-scripts` 不产生子进程。

**影响**：官方 `scripts/build-server.mjs`（调用 `git`/`npm` 用 `spawnSync`）与 3 个测试文件（`server-build`、`instance-lock`、`component-service`）无法直接运行。

**处理**：编写了进程内垫片 `_tools/sync-spawn-shim.cjs`，用 Worker 线程执行异步 `spawn`、主线程以 `SharedArrayBuffer` + `Atomics.wait` 阻塞等待、结果经临时文件回传。通过 **`--require` 预载**（不能用 `--import`：ESM 对 CJS 内建模块的具名导入是一次性快照，`--import` 时门面已建立，改动无效）。

**偏离声明**：

1. 被测脚本本身**未做任何修改**（垫片只在进程内替换 `child_process` 的同名导出）。
2. 垫片对被测代码的执行路径**不产生语义改变**：`spawnSync` 的阻塞等待、返回值形状（`status`/`stdout`/`stderr`/`error`）、非零退出码、命令不存在等行为均已逐一比对原生一致。
3. `npm test` 是在注入垫片的环境下运行的；对不使用同步子进程的 15 个测试文件**完全无影响**。
4. 本地 Node 为 **22.22.2**（非清单 `validatedNode` 22.17.1）——但归档哈希仍被完整复现（见 5.5）。
5. 辅助脚本全部放在 `repo/` **之外**（`qqa/_tools/`），避免污染 `git status`（否则会被写进 manifest 的 `changes`）。第一次实验确实观察到该污染 3 条（`?? _tools/`、`?? _spawn-probe.mjs`、`?? _spawn-probe2.mjs`），已清理并重跑。

其他环境限制：`wsl.exe` 被安全策略拦截；命令中出现 `cmd.exe` 字样会被命令校验拒绝。

---

## 九、明确未做的事项

- ❌ 未连接 `47.109.97.184` ECS，未登录、未部署、未重启任何线上服务。
- ❌ 未做 24 小时持续稳定性验收。
- ❌ 未做真实 QQ 扫码、Hook 加载、一收一发验收（需本人操作）。
- ❌ 未配置模型 API / 模型名（线上仍为未配置状态）。
- ⛔ 未修改、未重新构建、未替换甲方已部署的服务器包；本轮重建产物仅落在本地 `_results/`。

---

## 附录 A：产物与复现命令

### A.1 本地产物

| 路径 | 内容 |
| --- | --- |
| `qqa/repo/` | 基线源码（= 样本 `源码/`），文档已还原为定稿版 |
| `qqa/_results/npm-test.log` | 官方 `npm test` 完整日志（8m32s） |
| `qqa/_results/static-checks.log` | 静态校验日志 |
| `qqa/_results/B1/` | 当前基线重建包（`5808147a…`，930 文件） |
| `qqa/_results/B2/` | 第二次构建，用于确定性核对（同 B1） |
| `qqa/_results/C1/` | 文档对齐后重建包，**等于甲方已部署包 `f10e150c…`** |
| `qqa/_results/docs-backup/` | 4 个文档的基线版本备份（已还原并校验） |
| `qqa/_tools/` | 垫片与辅助脚本（不进入 `repo/`） |
| `qqa/_pkgcheck/` | 甲方服务器包解包件，用于逐文件核验 |

### A.2 复现命令

```bash
# 依赖
cd qqa/repo
npm ci --omit=dev --omit=optional --ignore-scripts

# 测试套件（本机需注入同步子进程垫片）
export NODE_OPTIONS="--require <abs>/qqa/_tools/sync-spawn-shim.cjs"
npm test

# 重建发布包
bash qqa/_tools/run-build.sh <输出目录>

# 官方自校验
node <包解包目录>/scripts/server/verify-release.mjs <包解包目录>

# 与甲方清单逐文件比对
python qqa/_tools/compare_package.py <重建.tar.gz> <甲方 server-manifest.json>
```

---

## 附录 B：关键哈希速查

| 对象 | SHA256 |
| --- | --- |
| 基线提交 | `da6f0560c1c7530a985bb4c1542a88cae104b80e` |
| 源码 `package.json` | `cb6248f90ee5524177a41ef9fbf4c3f70c559aefd9247d7d8bf8bd451d7ea322` |
| 源码 `package-lock.json` | `3f03d92a2eba47d4810c2c76a243dcbdd6e434029939d550531b3b4f2284c904` |
| 甲方已部署包（= 本次 C1 复现） | `f10e150c864f23e131fe5e9bf40a36644fe97f95bf3892776428a9493ae62789` |
| 本次从当前基线重建（B1 = B2） | `5808147ac1ad34bbb0c7e75a56f0312c6a4e9f507d04b696acffe52cca47603a` |
| 构建 epoch | `1791356893` |
