# QQ-Agent for Linux

> 一个面向 Linux 平台设计与优化的 QQ 机器人框架，基于 **OneBot v11** 协议，对接 **[SnowLuma](https://github.com/SnowLuma/SnowLuma)** 协议端。
> **A Linux-first QQ bot framework** built on **OneBot v11**, bridging to **SnowLuma**.

[简体中文](README.md) · **English**

[![Platform](https://img.shields.io/badge/platform-Linux-blue)](#)
[![Protocol](https://img.shields.io/badge/OneBot-v11-4b8bbe)](#-协议与协议端)
[![SnowLuma](https://img.shields.io/badge/protocol--end-SnowLuma-8aadf4)](https://github.com/SnowLuma/SnowLuma)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#-项目状态)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

---

## 📌 项目状态

**源码与程序包尚未发布，本仓库目前仅包含项目说明文档。**

当前阶段：**项目规划 / 架构设计**

- [x] 仓库建立、项目定位确定
- [x] 协议选型：OneBot v11
- [x] 协议端选型：SnowLuma
- [x] 实现语言确定：Python
- [ ] 核心框架实现
- [ ] SnowLuma 连接层实现
- [ ] 插件系统
- [ ] 配置与部署工具
- [ ] 首个可用版本发布（v0.1.0）
- [ ] 预编译程序包 / 发行版打包（`.deb` / `.rpm` / Docker 镜像）

如果你想第一时间收到发布通知，请 **Watch → Custom → Releases only** 订阅本仓库。

---

## 🎯 这是什么

QQ-Agent for Linux 的目标，是给 Linux 用户一个**真正为 Linux 而生**的 QQ 机器人运行环境——而不是把 Windows 上写好的东西勉强塞进容器里凑合跑。

它要做成一个 Agent：不只是被动响应关键词，而是能理解上下文、维护会话状态、按需调用外部能力来完成任务的智能体后端。

## ✨ 设计目标

| 目标 | 说明 |
| --- | --- |
| **Linux 原生** | 无需 Wine、无需图形界面、无冗余依赖，纯命令行运行 |
| **systemd 友好** | 提供服务单元模板，一条 `systemctl enable --now` 即可常驻 |
| **低资源占用** | 目标是在 1 核 512MB 的轻量云主机上稳定运行 |
| **Agent 架构** | 会话状态管理、多轮上下文、可插拔工具调用 |
| **插件化** | 功能模块独立加载，热重载，互不干扰 |
| **协议端解耦** | 通过 OneBot v11 标准协议对接，协议端可替换、可升级 |

## 🔌 协议与协议端

### 协议：OneBot v11

本项目以 **[OneBot v11](https://github.com/botuniverse/onebot-11)** 作为唯一对外通信契约。

选用 v11 而非 v12，是因为当前生态（协议端、SDK、周边工具）对 v11 的支持最完整成熟。标准化的好处是：**协议端被隔离在通信层之后**，未来若要更换或升级协议端，核心逻辑几乎不需要改动。

### 协议端：SnowLuma

**[SnowLuma](https://github.com/SnowLuma/SnowLuma)** 是面向 QQ 客户端的 TypeScript 互操作运行时，将 QQ 原生会话转换为 OneBot v11 动作与事件。

它提供多种对接入口，本项目的接入策略如下：

| 连接方式 | SnowLuma 侧角色 | 本项目计划 |
| --- | --- | --- |
| **正向 WebSocket** | WebSocket 服务端 | ✅ **首选**：本项目作为客户端主动连接，断线自动重连 |
| 反向 WebSocket | WebSocket 客户端 | ✅ 备选：本项目作为服务端监听，供 SnowLuma 回连 |
| HTTP / HTTP 上报 | HTTP 服务端 / 上报 | ⏳ 后续按需支持 |

**前置准备**（需自行完成，本项目不代管协议端）：

```bash
# 1. 从 SnowLuma Releases 下载完整发行包并解压
#    https://github.com/SnowLuma/SnowLuma/releases
#    Lite 版需 Node.js 22.13+（23 系需 23.4+）

# 2. Linux 下启动
chmod +x launcher.sh
./launcher.sh

# 3. 浏览器打开 WebUI，用启动日志中的初始密码登录
#    http://localhost:5099
#    扫码登录 QQ，并配置 OneBot 连接（记下端口与 access token）
```

> ⚠️ **注意**：SnowLuma 使用**源码可见非商业许可（source-available）**，并**不是** OSI 认可的开源许可；其二进制发行包另受 EULA 约束。使用前请阅读其 `LICENSE` 与 `EULA.md`，商业用途需另行取得授权。本项目与之仅为调用关系，不包含也不分发其任何代码或二进制。

## 🏗️ 计划中的架构

```
┌──────────────────────────────────────────────────────┐
│  协议端 SnowLuma（独立进程，自行部署）                  │
│  QQ 原生会话 ──► OneBot v11 动作 / 事件                │
│  WebUI :5099                                          │
└───────────────────────┬──────────────────────────────┘
                        │  OneBot v11 over WebSocket
                        │  （正向首选 / 反向备选）
┌───────────────────────▼──────────────────────────────┐
│  接入层 Access Layer                                  │
│  连接管理 · 断线重连 · 心跳 · 事件解析 · 动作封装       │
└───────────────────────┬──────────────────────────────┘
                        │  标准化内部事件
┌───────────────────────▼──────────────────────────────┐
│  核心层 Core                                          │
│  事件总线 · 会话管理 · 上下文存储 · 调度器              │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│  Agent 层 Agent Runtime                               │
│  意图理解 · 多轮对话 · 工具调用 · 记忆                 │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│  插件层 Plugin Layer                                  │
│  用户自定义功能模块，独立加载与热重载                   │
└──────────────────────────────────────────────────────┘
```

**分层要点**：协议端进程与本项目进程完全分离，两者之间只有 OneBot v11 这一条标准协议线。这意味着协议端崩溃不影响本项目状态管理，本项目重启也不需要重新登录 QQ。

> 架构仍在设计阶段，以上结构可能调整。

## 🗺️ 路线图

**v0.1.0 — 最小可用核心**
- 接入 SnowLuma 正向 WebSocket，实现消息收发
- 断线重连、心跳保活、access token 鉴权
- 基础事件分发与会话管理
- 命令行启动，支持配置文件

**v0.2.0 — 插件系统**
- 插件加载器与生命周期管理
- 简单的插件开发接口（SDK，Python）
- 热重载

**v0.3.0 — Agent 能力**
- 多轮上下文管理
- 工具调用框架
- 可选的模型服务接入

**v0.4.0 — 连接方式补全**
- 反向 WebSocket 支持
- HTTP / HTTP 上报支持
- 多账号（多协议端实例）并行

**v1.0.0 — 稳定发布**
- 完整的配置与部署文档
- systemd 服务单元
- 发行版安装包与 Docker 镜像

## 📦 安装

尚无可用版本，敬请期待。

未来计划提供以下安装方式：

```bash
# 方式一：预编译程序包（计划中）
sudo apt install ./qq-agent-for-linux_x.y.z_amd64.deb

# 方式二：Docker（计划中）
docker run -d --name qq-agent -v ./config:/etc/qq-agent ghcr.io/prolet1966/qq-agent-for-linux

# 方式三：源码构建（计划中）
git clone https://github.com/prolet1966/QQ-Agent-for-Linux.git
cd QQ-Agent-for-Linux && ./build.sh
```

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [架构设计](docs/architecture.md) | 分层职责、通信链路、会话模型、配置草案、待决问题 |
| [决策记录](docs/decisions.md) | 已做的决策及其理由、被否决的方案、尚待拍板的问题 |
| [SnowLuma 部署指南](docs/snowluma-setup.md) | 协议端安装、QQ 扫码登录、OneBot 连接配置与验证 |
| [贡献指南](CONTRIBUTING.md) | 当前阶段能做什么、Issue 与提交规范、行为准则 |

## 🤝 参与贡献

项目还在起步阶段，但现在正是**讨论与设计最容易产生价值**的时候。

- 有想法、有需求、有反对意见 → 欢迎开 [Issue](https://github.com/prolet1966/QQ-Agent-for-Linux/issues) 讨论
- 想参与开发 → 请先开 Issue 说明你的想法，避免重复劳动
- 发现问题 → 提交 Issue 时请附上系统版本、运行环境与复现步骤

## ⚠️ 免责声明

本项目为**非官方**开源项目，与腾讯公司、QQ 官方，以及 SnowLuma 项目均无隶属或授权关系。

使用者需自行遵守当地法律法规、腾讯 QQ 用户协议、SnowLuma 的许可条款及相关平台规则。请勿将本项目用于任何违法用途、垃圾信息发送、恶意骚扰或侵犯他人隐私的行为。因使用本项目产生的一切后果由使用者自行承担。

## 📄 许可证

本项目自身代码采用 [Apache License 2.0](LICENSE)。

选用 Apache-2.0 而非 MIT，是因为本项目定位为**框架**：Apache-2.0 在第 3 条中明确授予专利许可，并含专利 retaliation 条款，对企业与商业部署场景更清晰。它同样是宽松许可，允许自由使用、修改与再分发。

> **注意**：本仓库的 Apache-2.0 许可**不覆盖** [SnowLuma](https://github.com/SnowLuma/SnowLuma) 或任何第三方协议端。SnowLuma 采用**源码可见非商业许可（non-commercial）**，与本项目的许可相互独立，请分别遵守——**更换本项目的许可证不会改变 SnowLuma 对你的约束**。

---

<p align="center">
  <sub>Made for Linux · OneBot v11 · Powered by SnowLuma · 项目正在建设中，感谢你的耐心与关注</sub>
</p>
