# 服务器适配最终审查与验收记录

日期：2026-10-12。源码目录：`C:/Users/PC/Downloads/QQA/源码`，分支 `codex/server-2c2g`。本轮修改保留原作者署名和 MIT 许可证。

上线补记：新版已完成生产部署，QQA、SnowLuma 1.14.22 与临时 QQ 登录窗口经公网浏览器验证，旧安装及本任务临时目录已清理，保留一份回滚备份。具体部署、实机修复、最终测试及首次设置边界见 [server-deployment-20261012.md](../../构建产物/部署资料/server-deployment-20261012.md)；下文隔离压测和安装包启动检查保留此前源码验收阶段的证据。本次补记不重新构建或重启线上服务。

## 审查范围和结果

实现后分别审查控制台/协议代理、存储/发布回滚、资源/停止生命周期，再修复可复现问题并执行第二轮复查。已发现的问题全部闭环；没有已知尚未修复的 P1/P2 源码问题。这是当前修改的审查结论，不等同于真实 QQ 或长期稳定性保证。

| 发现 | 修复和验证 |
| --- | --- |
| 停止期间继续发送并写入已关闭数据库 | 关闭发送/HTTP准入，取消排队，等待在途存档、Agent、提醒及事件处理完成，最后关闭存储和释放锁 |
| 入站重启重放及写失败误确认 | SQLite FULL持久队列、UUID/sourceEventKey去重、JSON写失败丢弃缓存、失败退避/deadletter、处理完成屏障 |
| 同进程双开及旧锁并发清理 | 核心/维护共用排他锁，拥有者token、stale恢复guard、构造失败清理、竞争子进程回归 |
| 损坏或超大旧JSON被覆盖/全量读入 | 仅ENOENT新建，损坏保留报错；服务器JSON单档8MiB读写预算，超限提示离线迁移；单群错误不阻塞其他群积压恢复 |
| 超大历史详情及重试占满主线程 | Worker流式分页、显示预算、原件流下载；历史同步重试超过8MiB明确拒绝并保留档案 |
| 旧消息无法滚动到达 | API真实offset/limit/nextOffset，UI按服务端页加载，字节短页不跳消息，旧响应不能覆盖当前选择 |
| 图片批量读取无总预算 | 2c2g整批原始图片8MiB、共享并发队列、慢响应完成后释放槽；外部OneBot只用远端下载URL |
| 异常HTTP Upgrade导致核心退出 | URL解析边界返回400，真实TCP异常请求后核心仍存活 |
| 在线reset破坏打开的SQLite/认证数据 | 服务器在线reset返回409，要求停核心后备份维护 |
| external模式停止本机组件 | 路由和函数双层拒绝本机QQ/SnowLuma停止操作 |
| SnowLuma登录后CSS/子路由失效 | 固定1.14.22 Vite预加载、Router basepath、公共路径/历史跳转、头像/上传背景路径改写；其他版本明确回退本地转发 |
| 安装端口错误或失败不能恢复 | 切换前校验端口/路径，保存unit-state；健康检查失败恢复旧release、unit、Node路径及服务状态 |
| 实机SnowLuma启动器经current软链接静默退出 | CLI入口使用realpath识别；真实软链接启动和初始密码过滤回归 |
| Ubuntu22.04旧polkit不执行JS授权规则 | 可选固定组件Unix socket兼容；保留核心NoNewPrivileges，仅0600服务用户socket、3个unit和3种动作，超限/未知操作拒绝 |

仓库内原有 bundled `skills/`、`plugins/` 已删除。保留核心扩展框架与商城，安装目录在用户数据区，禁用模块不会导入执行。

## 最终自动验证

运行时为 Node.js 22.17.1。

| 环境 | 结果 |
| --- | --- |
| Windows完整 `npm test` | 123项；118通过、5个Linux专项场景跳过、0失败 |
| 目标ECS隔离Linux完整套件 | 123项全部通过，0跳过、0失败；包括3个Linux安装/回滚沙箱场景 |
| JS/MJS语法和shell语法 | 129个JS/MJS、全部服务器shell脚本以及git diff检查通过 |
| 发行包 | 构建、文件哈希完整性、篡改拒绝及同源码重复构建由server-build测试覆盖；目标ECS普通用户只读安装目录启动检查通过，见下文 |

目标ECS：`i-2vc3qupw44r98d5you5e`，Ubuntu 22.04.5，2 vCPU，实际可见内存约1736MiB。测试使用隔离目录，不向真实QQ或计费模型发送消息。最终123项复测日志保存在项目外 `C:/Users/PC/Downloads/QQA/构建产物/验证记录/windows-deployment-final-tests.log` 与 `ecs-deployment-final-tests.log`，Linux副本亦在部署回滚备份中；原 `/tmp/qqa-validation-final-20261012/source` 等测试目录已在上线收尾清理。

复现：

```sh
npm ci --omit=dev --omit=optional --ignore-scripts
npm test
for file in scripts/server/*.sh; do bash -n "$file" || exit 1; done
node scripts/server-benchmark.mjs --normal-seconds 10 --burst-seconds 60 --output /绝对路径/benchmark.json
npm run build:server
```

压测脚本运行真实createApp子进程、持久事件队列和SQLite，模拟OneBot与模型，使用临时数据目录和5个白名单群。检查完整接入/落盘/去重/回复/停机锁，并采集核心PSS/RSS、heap/external、CPU、事件循环及认证控制台响应延迟。默认压力阶段约70秒；不自动安排24小时运行。短测结果与长时间稳定性分别记录。

## 目标 ECS 隔离压测结果

最终测量于 2026-10-12 04:27（北京时间）开始，总计 71.87 秒。普通阶段 5 条/秒持续 10 秒，突发阶段 20 条/秒持续 60 秒，五个群各 250 条新消息，另投入 5 条重复事件。真实核心、持久 EventInbox、SQLite、编排器和发送队列参与运行；模型使用 10 ms 延迟的模拟响应，OneBot 为本机模拟端。

| 指标 | 最终实测 |
| --- | --- |
| 事件接收 / 完成 | 1255 / 1255；失败、拒绝、deadletter 和结束时积压均为 0 |
| 聊天归档 / 模拟回复 | 1250 / 1250；重复事件不追加、不重复调用模型、不重复发送 |
| 核心峰值 PSS / RSS | 134.71 / 160.84 MiB |
| 核心峰值 heapUsed / external | 34.12 / 5.59 MiB |
| 核心峰值 CPU | 34.58%；以一个逻辑核 100% 计，实际有效采样窗口均超过 1000 ms |
| 核心 Swap | 0 |
| 已认证控制台会话接口 p95 / 最大 | 直方图上界 20 ms / 15.74 ms，共 76 次采样 |
| 事件循环 p99 峰值 / 最大阻塞 | 54.98 / 58.03 ms，包含启动阶段 |
| 停机 | 23.99 ms，正常退出码 0，无强制终止，锁释放且下一实例可取得锁 |
| 验证断言 | 17 项全部通过 |

原始最终报告保存在 `C:/Users/PC/Downloads/QQA/构建产物/验证记录/ecs-benchmark-reviewed.json`，服务器留存于 `/var/backups/qq-agent/deploy-20261011-204816/isolated-benchmark-reviewed.json`；原 `/tmp/qqa-validation-final-20261012/benchmark-reviewed.json` 已清理。测量脚本 SHA256 为 `3d1d764e906d09d02fb80a66590e4f255dbe67def007dd6aad1d592bb763f3c4`。CPU 计算跳过短于采样预算的窗口并保留有效基线，不以短窗口 tick 误差放大峰值，也不钳制合法的多核占用。

资源数字只覆盖隔离的 QQA 核心，不包括 QQ、SnowLuma、Xvfb 或整个系统的内存。模拟模型的速度不代表真实服务响应，短测不证明 24 小时稳定性。以上数字来自修正测量脚本后的重新运行；旧测量报告已随本地陈旧验证文件清理，保留已审查的最终报告。

## 服务器安装包启动检查

在目标 ECS 的全新 `/tmp/qqa-package-smoke-*/` 目录解包服务器归档，核对归档 SHA256 和全部 927 个清单文件。代码目录为 root 属主且不可由服务用户写入，以现有普通用户 `qqa`（UID 1001）和可读取的 Node 22.17.1 启动，清空 DISPLAY，使用新建的独立数据目录、回环地址和临时空闲端口。协议端设为 external 并指向隔离端口，不连接真实 QQ/SnowLuma。

18 项检查全部通过：无 bundled Skill/插件或 Electron；普通用户读取只读代码并写入自己的数据区；未登录 API 返回 401；控制台登录、Cookie、SQLite 运行状态、会话列表和页面正常；登出后旧会话失效；SIGTERM 正常退出码 0、无需强制终止、锁消失，启动前后发行文件哈希保持一致。原始结果保存在 `C:/Users/PC/Downloads/QQA/构建产物/验证记录/ecs-package-smoke-reviewed.json`，当时的临时检查脚本已随旧验证目录清理，最终检查结果保留。文档收尾后重新构建归档，并对最终交付包再次执行相同检查；实际归档哈希以旁边的 `.sha256` 为准，避免在包内写入自身哈希。

以上为此前源码验收阶段的隔离启动检查，当时没有替换旧生产 QQA。后续已按 `server-install.md` 准备独立运行时和服务配置，部署实机修复后的 930 文件归档并清理旧版；原 QQ 进程及登录数据保留。安装包不捆绑 Node 或协议端，实际安装位置与包来源以部署记录为准。

## SnowLuma真实前端兼容验证

使用官方1.14.22发行包中的真实client静态资源和本地mock协议API完成浏览器验证：控制台登录、总览懒加载、进程注入子页面及正确标题。22个改写后的JS文件语法检查通过，API字面量、Vite预加载依赖和Router basepath改写已独立复查。页面截图：`C:/Users/PC/Downloads/QQA/构建产物/验证记录/snowluma-1.14.22-proxy-processes.png`。

此验证证明前端代理路径兼容，未证明真实Hook、QQ登录和协议收发完成。

## 真实验收边界

生产部署和真实SnowLuma登录/首次设置页面、QQ扫码窗口已验证。EULA/privacy确认、密码修改和扫码由用户本人操作；Hook与QQ登录后的真实一收一发、模型API配置及24小时稳定性仍待各自实际完成后记录。真实QQ不可用时，不使用模拟收发冒充成功。

核心升级和消息存储迁移有各自独立的回滚流程。备份完整DATA_DIR（包括SQLite WAL/SHM、inbox UUID、认证、配置、会话和用户扩展），QQ HOME和SnowLuma配置/数据另行保留。构建manifest如标记dirty=true，应按“已审查的本地修改构建”识别，不冒充GitHub官方发行版或干净提交。
