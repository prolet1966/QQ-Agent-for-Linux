# QQ-Agent for Linux

> A QQ bot framework designed and optimized for Linux, built on the **OneBot v11** protocol and bridging to **[SnowLuma](https://github.com/SnowLuma/SnowLuma)**.
> **A Linux-first QQ bot framework** built on **OneBot v11**, bridging to **SnowLuma**.

**English** · [简体中文](README.md)

[![Platform](https://img.shields.io/badge/platform-Linux-blue)](#)
[![Protocol](https://img.shields.io/badge/OneBot-v11-4b8bbe)](#-protocol--protocol-end)
[![SnowLuma](https://img.shields.io/badge/protocol--end-SnowLuma-8aadf4)](https://github.com/SnowLuma/SnowLuma)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#-project-status)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

---

## 📌 Project Status

**Source code and packages are not released yet. This repository currently contains documentation only.**

Current stage: **planning / architecture design**

- [x] Repository created, project scope defined
- [x] Protocol chosen: OneBot v11
- [x] Protocol end chosen: SnowLuma
- [ ] Core framework implementation
- [ ] SnowLuma connection layer
- [ ] Plugin system
- [ ] Configuration and deployment tooling
- [ ] First usable release (v0.1.0)
- [ ] Prebuilt packages (`.deb` / `.rpm` / Docker image)

To be notified on release, use **Watch → Custom → Releases only**.

---

## 🎯 What This Is

QQ-Agent for Linux aims to give Linux users a QQ bot runtime that is **genuinely built for Linux** — not something written for Windows and squeezed into a container as an afterthought.

It is meant to be an *Agent*, not merely a keyword responder: it understands context, maintains conversation state, and invokes external capabilities on demand.

## ✨ Design Goals

| Goal | Description |
| --- | --- |
| **Linux native** | No Wine, no GUI, no bloat — runs purely from the command line |
| **systemd friendly** | Ships a service unit template; a single `systemctl enable --now` keeps it running |
| **Low footprint** | Target: stable operation on a 1 vCPU / 512 MB lightweight cloud instance |
| **Agent architecture** | Session state, multi-turn context, pluggable tool invocation |
| **Plugin based** | Feature modules load independently, hot-reload, and stay isolated |
| **Decoupled protocol end** | Talks over the OneBot v11 standard, so the protocol end is replaceable |

## 🔌 Protocol & Protocol End

### Protocol: OneBot v11

This project uses **[OneBot v11](https://github.com/botuniverse/onebot-11)** as its single external contract.

v11 was chosen over v12 because the ecosystem (protocol ends, SDKs, tooling) has the most complete and mature support for it. The benefit of standardization: **the protocol end is isolated behind the transport layer**, so replacing or upgrading it later requires almost no change to core logic.

### Protocol End: SnowLuma

**[SnowLuma](https://github.com/SnowLuma/SnowLuma)** is a TypeScript interoperability runtime for QQ clients that converts native QQ sessions into OneBot v11 actions and events.

It exposes several entry points. Our integration strategy:

| Connection mode | SnowLuma role | Plan |
| --- | --- | --- |
| **Forward WebSocket** | WebSocket server | ✅ **Preferred** — this project connects out, reconnects automatically |
| Reverse WebSocket | WebSocket client | ✅ Alternative — this project listens, SnowLuma dials back |
| HTTP / HTTP report | HTTP server | ⏳ Undecided, added on demand later |

**Prerequisites** (you set this up yourself — this project does not manage the protocol end):

```bash
# 1. Download the full release bundle from SnowLuma Releases
#    https://github.com/SnowLuma/SnowLuma/releases
#    The Lite build requires Node.js 22.13+ (23.4+ on the 23.x line)

# 2. Start it on Linux
chmod +x launcher.sh
./launcher.sh

# 3. Open the WebUI and log in with the initial password from the startup log
#    http://localhost:5099
#    Scan the QR code to log in QQ, then configure the OneBot connection
```

> ⚠️ **Licensing notice**: SnowLuma is distributed under a **source-available, non-commercial license** and is **not** OSI open source. Its binary releases are additionally governed by its `EULA.md`. Read its `LICENSE` and `EULA.md` before use; commercial use requires prior written permission. This project merely calls it and neither includes nor redistributes any of its code or binaries.

## 🏗️ Planned Architecture

```
┌──────────────────────────────────────────────────────┐
│  Protocol end: SnowLuma (separate process, self-hosted)│
│  native QQ session ──► OneBot v11 actions / events    │
│  WebUI :5099                                          │
└───────────────────────┬──────────────────────────────┘
                        │  OneBot v11 over WebSocket
                        │  (forward preferred / reverse alt.)
┌───────────────────────▼──────────────────────────────┐
│  Access Layer                                         │
│  connection · reconnect · heartbeat · event parsing    │
└───────────────────────┬──────────────────────────────┘
                        │  normalized internal events
┌───────────────────────▼──────────────────────────────┐
│  Core Layer                                           │
│  event bus · session management · storage · scheduler  │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│  Agent Layer                                          │
│  intent · multi-turn context · tool calls · memory     │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│  Plugin Layer                                         │
│  user-defined modules, independently loaded            │
└──────────────────────────────────────────────────────┘
```

**Key point**: the protocol end and this project run as separate processes, connected only by the OneBot v11 standard. A crash on the protocol end does not affect this project's state management, and restarting this project does not require logging into QQ again.

> The architecture is still in design. The structure above may change.

## 🗺️ Roadmap

**v0.1.0 — Minimum viable core**
- Connect to SnowLuma over forward WebSocket; send and receive messages
- Reconnect, heartbeat keepalive, access token auth
- Basic event dispatch and session management
- CLI startup with a configuration file

**v0.2.0 — Plugin system**
- Plugin loader and lifecycle management
- A simple plugin SDK
- Hot reload

**v0.3.0 — Agent capabilities**
- Multi-turn context management
- Tool invocation framework
- Optional model service integration

**v0.4.0 — Connection modes**
- Reverse WebSocket
- HTTP / HTTP report
- Multiple accounts (multiple protocol end instances) in parallel

**v1.0.0 — Stable release**
- Complete configuration and deployment docs
- systemd service unit
- Distribution packages and Docker image

## 📦 Installation

No release is available yet.

Planned installation methods:

```bash
# Option 1: prebuilt package (planned)
sudo apt install ./qq-agent-for-linux_x.y.z_amd64.deb

# Option 2: Docker (planned)
docker run -d --name qq-agent -v ./config:/etc/qq-agent ghcr.io/prolet1966/qq-agent-for-linux

# Option 3: build from source (planned)
git clone https://github.com/prolet1966/QQ-Agent-for-Linux.git
cd QQ-Agent-for-Linux && ./build.sh
```

## 📚 Documentation

| Document | Content |
| --- | --- |
| [Architecture](docs/architecture.md) | Layer responsibilities, transport, session model, config draft, open questions |
| [Decision Records](docs/decisions.md) | Why a given decision was made, and what is still undecided |
| [SnowLuma Setup](docs/snowluma-setup.md) | Protocol end install, QQ QR login, OneBot connection setup and verification |
| [Contributing](CONTRIBUTING.md) | What to contribute at this stage, issue and commit conventions |

> These documents are currently written in Chinese.

## 🤝 Contributing

The project is at an early stage, and this is exactly when **discussion and design have the highest leverage**.

- Ideas, requirements, or disagreements → open an [Issue](https://github.com/prolet1966/QQ-Agent-for-Linux/issues)
- Want to write code → open an Issue first to align on direction and avoid duplicated effort
- Found a problem → include distro version, environment, and reproduction steps

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## ⚠️ Disclaimer

This is an **unofficial** open-source project. It is not affiliated with or authorized by Tencent, QQ, or the SnowLuma project.

Users are responsible for complying with local laws, the Tencent QQ Terms of Service, SnowLuma's license terms, and applicable platform rules. Do not use this project for any illegal purpose, spam, harassment, or privacy violations. All consequences of use are borne by the user.

## 📄 License

This project's own code is licensed under the [Apache License 2.0](LICENSE).

Apache-2.0 was chosen over MIT because this project is a **framework**: Apache-2.0 grants an explicit patent license in Section 3 and includes a patent retaliation clause, which is clearer for enterprise and commercial deployment. It remains a permissive license — free to use, modify, and redistribute.

> **Note**: The Apache-2.0 license of this repository does **not** cover [SnowLuma](https://github.com/SnowLuma/SnowLuma) or any third-party protocol end. SnowLuma uses a **source-available, non-commercial** license, independent of this project's license, and both must be complied with separately — **changing this project's license does not change SnowLuma's restrictions on you**.

---

<p align="center">
  <sub>Made for Linux · OneBot v11 · Powered by SnowLuma · Under construction, thanks for your patience</sub>
</p>
