# 洛版 for Linux · 说明

> QQ Agent V0.4.4 的 Linux 移植版。**自包含**：内置 SnowLuma 协议端与 Electron 运行时，
> 不需要另外装 Node，也不需要单独部署协议端。

---

## 这个包适合谁

想在 Linux 上跑 QQ 群 AI 机器人的人。装完即可扫码登录，不需要懂 Node、不需要配环境。

**系统要求**

| 项目 | 要求 |
| --- | --- |
| 架构 | **x86_64**（只提供 64 位） |
| 发行版 | Debian 11+ / Ubuntu 20.04+ / RHEL 8+ |
| C 库 | glibc ≥ 2.28 —— ⚠️ **Alpine 用不了**（musl） |
| 内存 | ≥ 2 GB |
| 磁盘 | ≥ 4 GB |
| 桌面 | 需要图形界面（扫码登录 QQ 必须有窗口） |

---

## 三个包怎么选

| 你的系统 | 用哪个 |
| --- | --- |
| Debian、Ubuntu、Linux Mint、Deepin | `洛版-for-Linux.deb` |
| RHEL、Fedora、Rocky、AlmaLinux、openSUSE | `洛版-for-Linux.rpm` |
| 其它 / 不想安装 / 想放 U 盘带走 | `洛版-for-Linux.AppImage` |

三个包**内容完全一样**，只是打包格式不同。任选其一即可，不要重复装。

---

## 安装

### Debian / Ubuntu

```bash
sudo apt install ./洛版-for-Linux.deb
qq-agent
```

装完后命令就是 `qq-agent`，也可以在应用菜单里找到「QQ Agent」。

### RHEL / Fedora / Rocky

```bash
sudo dnf install ./洛版-for-Linux.rpm
qq-agent
```

### 任意发行版（AppImage）

```bash
chmod +x 洛版-for-Linux.AppImage
./洛版-for-Linux.AppImage
```

> **AppImage 在 Ubuntu 24.04 及以上可能报错**：
> `dlopen(): error loading libfuse.so.2`
>
> 这是 AppImage 格式的通用问题，不是本程序的问题。二选一解决：
>
> ```bash
> # 方法一：装上兼容库（一次即好，之后可双击运行）
> sudo apt install libfuse2t64
>
> # 方法二：改用解包模式运行（不装任何东西）
> ./洛版-for-Linux.AppImage --appimage-extract-and-run
> ```

---

## ⚠️ 装完必须先做两件事，否则机器人不会工作

### 第一件：安装 Linux 版 QQ

本程序的协议端（SnowLuma）工作方式是**注入一个正在运行的 QQ 客户端**。
所以它**不能替代 QQ**，你必须自己装一个：

```bash
# 从腾讯官网下载 Linux 版：https://im.qq.com/linuxqq/
sudo apt install ./QQ_*.deb
```

装完会在 `/opt/QQ/qq`。程序会自动找到它。

> **QQ 版本必须与协议端兼容**。版本不匹配时表现为「QQ 能登录，但机器人收不到消息」。
> 遇到这种情况请换一个 QQ 版本再试。

### 第二件：放开内核的进程注入限制

Ubuntu 默认禁止普通程序注入别的进程，协议端会因此失败（报 `COMPONENT_LOAD_FAILED`）：

```bash
echo "kernel.yama.ptrace_scope = 0" | sudo tee /etc/sysctl.d/99-ptrace-inject.conf
sudo sysctl -p /etc/sysctl.d/99-ptrace-inject.conf
```

> 这**放宽了系统的一项安全限制**（允许同用户的进程之间互相注入）。
> 如果你这台机器还干别的用途，请先了解它的影响再决定。

### 还有一条：不要用 sudo 运行

```bash
sudo qq-agent      # ❌ 不要这样
qq-agent           # ✅ 这样
```

数据存在你的主目录里。用 sudo 跑会把文件属主改成 root，之后普通用户启动就读写失败。

---

## 首次使用流程

1. 启动 `qq-agent`
2. 在界面里点**启动 SnowLuma**（内置模式，日志会显示在界面里）
3. 点**启动 QQ** —— 会弹出 QQ 扫码窗口，用手机 QQ 扫码登录
4. 在 SnowLuma 的 WebUI（地址通常是 `http://127.0.0.1:5099`）里完成 OneBot 连接配置
5. 回到 QQ Agent 的「设置」，填入你的大模型 API 地址和 Key
   （例如 DeepSeek 的 `https://api.deepseek.com/v1`）

### 数据存在哪

按 Linux 的 XDG 规范，放在你的主目录：

```
~/.local/share/qq-agent/
```

配置、会话记录、记忆、表情库都在里面。**卸载程序不会删除这个目录。**

想放到别处（比如大容量磁盘），设个环境变量即可：

```bash
QQ_AGENT_DATA_DIR=/mnt/data/qq-agent qq-agent
```

### 想同时跑两个机器人账号

```bash
QQ_AGENT_PROFILE=2 qq-agent
```

数据目录会变成 `qq-agent-2`，端口自动错开，两个实例互不干扰。

---

## 自带的东西

| 内容 | 数量 | 说明 |
| --- | --- | --- |
| 技能 | 41 个 | 大部分默认关闭，可在界面按需启用 |
| 插件 | 29 个 | 同上 |

**新增的扩展默认都是关闭状态**，不会在你不知情的情况下改变机器人的行为。
需要哪个就在界面里打开。

---

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动后界面空白 | 缺图形库。Debian/Ubuntu 执行 `sudo apt install libnss3 libgtk-3-0 libasound2t64 libgbm1` |
| 提示无法写入数据目录 | 之前用 sudo 跑过：`sudo chown -R $USER ~/.local/share/qq-agent` |
| QQ 登录了但机器人不回话 | 十有八九是第五节的 `ptrace_scope` 没放开 |
| 上面那条已做还是不行 | QQ 版本与协议端不兼容，换 QQ 版本 |
| 卡片图片里中文是方块 | 缺中文字体：`sudo apt install fonts-noto-cjk` |
| 点「打开数据目录」没反应 | 缺 `xdg-utils`：`sudo apt install xdg-utils` |
| 日志里有 `GPU process isn't usable` | **通常可以忽略**。这个报错与本程序无关，是无图形加速环境（尤其 WSL）的常见现象；只要数据目录正常创建、界面能开就没问题 |
| 扫码窗口看不到 | 无头/纯命令行环境。需要在有桌面的会话里登录，或配 VNC |

日志位置：`~/.local/share/qq-agent/logs/`

> 程序默认会把日志里的长数字 ID 打码，所以日志可以直接贴出来求助，
> 但仍建议自己检查一遍再发。

---

## 校验文件完整性

下载或拷贝过程中文件可能损坏。核对一下：

```bash
sha256sum -c SHA256SUMS.txt
```

全部显示 `OK` 就没问题。应得到：

```
洛版-for-Linux.deb        023ebec3b80c565a...
洛版-for-Linux.rpm        7eab74f312d81373...
洛版-for-Linux.AppImage   71fa67768a37a8bf...
```

---

## 卸载

```bash
sudo apt remove qq-agent     # Debian / Ubuntu
sudo dnf remove qq-agent     # RHEL / Fedora
```

**用户数据不会被删除**（这是有意设计）。要彻底清干净：

```bash
rm -rf ~/.local/share/qq-agent
```

AppImage 直接删文件即可。

---

## 关于来源与授权

- 上游项目 **QQ Agent** 由 **Kondius** 开发，MIT 许可：
  <https://github.com/Kondius/qq-agent>
  本移植版保留了原作者署名与许可，`LICENSE` 文件随附在源码仓库里。
- 内置的 **SnowLuma** 协议端是独立第三方项目，采用**源码可见非商业许可**
  （**不是**开源许可）。商业使用需要另行取得其作者授权。
- 本程序与腾讯 / QQ 官方**没有关系**，也未获其授权。
  请遵守《QQ 用户协议》以及你所在地区的法律。

---

## 更多

- 源码仓库：<https://github.com/prolet1966/QQ-Agent-for-Linux>
- 发行包下载：<https://github.com/prolet1966/QQ-Agent-for-Linux/releases/tag/v0.4.4-linux>
- 详细安装与踩坑说明：仓库内 `docs/linux-install.md`
- 移植改动与验证报告：仓库内 `docs/linux-delivery-report.md`
