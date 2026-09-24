# SnowLuma 协议端部署指南

> 本项目**不包含也不分发** SnowLuma。协议端需要你自行部署，本文说明部署流程与本项目所需的连接配置。

## 前置要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Linux（Windows / macOS 亦可用，本项目面向 Linux） |
| Node.js | **22.13+**；若使用 23 系需 **23.4+**（仅 Lite 版需要） |
| 磁盘 | 预留数 GB 用于 QQ 运行数据与消息存储 |

## 一、获取 SnowLuma

从官方 Releases 下载对应平台的完整发行包：

<https://github.com/SnowLuma/SnowLuma/releases>

解压到合适位置，例如 `~/snowluma`：

```bash
mkdir -p ~/snowluma
# 将下载的发行包解压至该目录
```

> ⚠️ **许可提醒**：SnowLuma 使用**源码可见非商业许可（source-available）**，并**不是** OSI 认可的开源许可。商业使用、公开发布修改版或衍生版，均需事先取得其书面授权。二进制发行包另受 `EULA.md` 与 `PRIVACY.md` 约束。请在使用前阅读其仓库内的 `LICENSE` 与 `EULA.md`。

## 二、启动

```bash
cd ~/snowluma
chmod +x launcher.sh
./launcher.sh
```

启动日志中会输出 **WebUI 的初始密码**，请留意记录。

## 三、登录 WebUI 并接入 QQ

1. 浏览器打开 <http://localhost:5099>
2. 使用启动日志中的初始密码登录
3. 按引导接入 QQ 进程
4. **扫码登录** QQ —— SnowLuma 只支持扫码登录，没有 CLI 登录方式

<!-- -->

> 🔐 **安全提示**：WebUI 默认监听 `5099` 端口。如果这台机器有公网 IP，请务必配置防火墙限制访问来源，或只通过 SSH 隧道访问：
>
> ```bash
> # 在本地机器上执行，将远端 5099 映射到本地
> ssh -L 5099:127.0.0.1:5099 user@your-server
> ```

## 四、配置 OneBot 连接

在 WebUI 中配置 OneBot 连接方式。本项目**首选正向 WebSocket**：由本项目主动连接 SnowLuma。

需要从 SnowLuma 侧取得两项信息，填入本项目的配置：

| 配置项 | 从哪来 |
| --- | --- |
| **WebSocket 地址** | WebUI 中你设定的 OneBot WS 监听端口，例如 `ws://127.0.0.1:3001` |
| **Access Token** | WebUI 中设定的鉴权 token，未设置则留空 |

对应本项目配置（草案，见 [架构设计](architecture.md)）：

```yaml
protocol_end:
  mode: forward
  url: ws://127.0.0.1:3001
  access_token: "你的token"
```

若改用**反向 WebSocket**，则改为本项目监听端口、由 SnowLuma 回连：

```yaml
protocol_end:
  mode: reverse
  listen: 0.0.0.0:8080
  access_token: "你的token"
```

并在 SnowLuma 的 WebUI 中把 OneBot 连接指向 `ws://<本项目地址>:8080`。

## 五、验证连接

SnowLuma 提供的 OneBot 动作与事件参考：

<https://github.com/SnowLuma/SnowLuma/blob/dev/docs/onebot-actions.md>

可用该文档核对连接是否正常，例如发送一条测试消息：

```json
{"action": "send_private_msg", "params": {"user_id": 123456789, "message": "hello"}}
```

## 常见问题

**Q：WebUI 打不开？**
检查 `launcher.sh` 是否仍在运行、端口是否为 5099 且未被占用（`ss -ltnp | grep 5099`）。

**Q：忘记 WebUI 密码？**
首次密码在启动日志中；重置方式请参考 SnowLuma 官方文档 <https://snowluma.github.io/zh/>。

**Q：QQ 掉线？**
SnowLuma 侧需要重新扫码登录。本项目的会话上下文存储独立于协议端，重新登录后历史上下文仍在。

**Q：本项目连不上 OneBot 端口？**
先用 `ss -ltnp` 确认端口在监听，再确认防火墙与本项目配置中的地址一致（注意 `127.0.0.1` 与 `0.0.0.0` 的区别）。

## 相关链接

- SnowLuma 仓库：<https://github.com/SnowLuma/SnowLuma>
- SnowLuma 文档：<https://snowluma.github.io/zh/>
- OneBot v11 标准：<https://github.com/botuniverse/onebot-11>
- 本项目架构设计：[architecture.md](architecture.md)
