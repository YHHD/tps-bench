# TPS Bench

本地 LLM API 测速台：连续发起 5 轮流式请求，测量首字延迟（TTFT）、解码速度（decode TPS）和端到端吞吐（E2E TPS），用来对比不同供应商和模型的真实响应速度。

A local benchmark for LLM APIs: five streaming rounds measuring time-to-first-token (TTFT), decode TPS and end-to-end throughput, so you can compare providers and models on the same footing.

![TPS Bench 界面](docs/screenshot.png)

[中文](#中文) · [English](#english)

---

## 中文

### 功能

- 5 轮基准测试，逐轮记录 TTFT、decode TPS、E2E TPS、总耗时、输入/输出 token
- 统计 p50 / p95 / min / max、成功率、与基线的对比
- 供应商排行榜（谁更快）和趋势图
- 历史记录保存在浏览器 localStorage，可回看、删除
- 四种接入方式：CC Switch（默认）、OpenCode Go、Anthropic、OpenAI 兼容
- 明暗主题、流式输出、桌面与移动端自适应
- 零 npm 依赖，单页应用 + 本地 Node 代理

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | >= 18 |
| sqlite3 | macOS 自带；Linux 需自行安装（仅 CC Switch 模式需要） |
| CC Switch | 仅 `cc-switch` 协议需要，本机安装并运行 |

### 快速开始

```bash
git clone https://github.com/YHHD/tps-bench.git
cd tps-bench
npm start
```

然后打开 <http://127.0.0.1:8787/>，在页面顶部选择协议并开始测试。无需 `npm install`。

### 协议说明

| 协议 | 请求路径 | 说明 |
| --- | --- | --- |
| `cc-switch` | 浏览器 → 本地代理 → CC Switch 本地路由 | 代理以只读方式打开 `~/.cc-switch/cc-switch.db`，读取供应商的 Base URL、模型目录和凭据；凭据只在代理进程内使用，不返回浏览器、不写日志 |
| `opencode-go` | 浏览器 → 本地代理 → `OPENCODE_UPSTREAM` | 默认上游为 `https://opencode.ai/inference/go/openai/v1/chat/completions`，可附带 `x-opencode-session` |
| `anthropic` | 浏览器 → 本地代理 → `ANTHROPIC_UPSTREAM` | Base URL 填 `https://api.anthropic.com` 时页面会自动改用本地代理，由代理转发 |
| `openai` | 浏览器直连你填写的 Base URL | 上游必须允许 CORS；API Key 只保存在浏览器中 |

CC Switch 模式下，只有同时具备 Base URL、已存 API Key 和模型目录的供应商可测；仅 OAuth 登录的供应商会显示为“不可测”。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 本地服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `CC_SWITCH_ORIGIN` | `http://127.0.0.1:15721` | CC Switch 本地路由地址 |
| `CC_SWITCH_DB` | `~/.cc-switch/cc-switch.db` | CC Switch 数据库路径 |
| `OPENCODE_UPSTREAM` | `https://opencode.ai/inference/go/openai/v1/chat/completions` | `opencode-go` 协议的上游 |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com/v1/messages` | `anthropic` 协议的上游 |
| `TPS_BENCH_UA` | `tps-bench/1.0` | 请求使用的 User-Agent |

### macOS 开机自启（可选）

```bash
NODE_BIN=$(command -v node)
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__PROJECT_DIR__|$PWD|g" \
  deploy/com.tps-bench.proxy.plist.example \
  > ~/Library/LaunchAgents/com.tps-bench.proxy.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tps-bench.proxy.plist
```

停止并移除：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tps-bench.proxy.plist
rm ~/Library/LaunchAgents/com.tps-bench.proxy.plist
```

日志写入 `/tmp/tps-bench-proxy.log` 和 `/tmp/tps-bench-proxy.error.log`。

### 隐私与安全

- 代理默认只监听 `127.0.0.1`。不要改成 `0.0.0.0` 后暴露在不可信网络中。
- 没有遥测、统计或外部上报；页面只请求你配置的端点。
- 配置和历史记录保存在当前浏览器的 localStorage。
- CC Switch 数据库只读访问；凭据不离开本地代理进程。
- 基准测试会消耗真实 API 额度，请自行控制轮次和 token 上限。

### 项目结构

```
tps-bench/
├── tps-bench.html                      # 单页界面与应用逻辑
├── opencode-proxy.mjs                  # 本地代理 + 静态文件服务
├── basecoat.css                        # Tailwind CSS 构建产物
├── deploy/com.tps-bench.proxy.plist.example
├── package.json
└── LICENSE
```

### 许可

[MIT](LICENSE)。`basecoat.css` 是 Tailwind CSS v4.3.1 的构建产物（MIT）。

---

## English

### Features

- Five benchmark rounds recording TTFT, decode TPS, E2E TPS, total time and token usage
- p50 / p95 / min / max, success rate and baseline comparison
- Provider leaderboard and per-run trend charts
- Run history stored in browser localStorage
- Four connection modes: CC Switch (default), OpenCode Go, Anthropic and OpenAI-compatible
- Light/dark themes, streaming output, responsive layout
- Zero npm dependencies: a single-page app plus a small local Node proxy

The UI is in Chinese (labels such as 协议 = protocol, 供应商 = provider, 模型 = model).

### Requirements

| Item | Requirement |
| --- | --- |
| Node.js | >= 18 |
| sqlite3 | Bundled with macOS; install separately on Linux (CC Switch mode only) |
| CC Switch | Required only for the `cc-switch` mode; must be installed and running |

### Quick start

```bash
git clone https://github.com/YHHD/tps-bench.git
cd tps-bench
npm start
```

Open <http://127.0.0.1:8787/>, pick a protocol and run a benchmark. No `npm install` needed.

### Protocols

| Protocol | Path | Notes |
| --- | --- | --- |
| `cc-switch` | browser → local proxy → CC Switch router | The proxy opens `~/.cc-switch/cc-switch.db` read-only to read each provider's base URL, model catalog and credentials. Credentials stay in the proxy process and are never returned to the browser or logged |
| `opencode-go` | browser → local proxy → `OPENCODE_UPSTREAM` | Defaults to `https://opencode.ai/inference/go/openai/v1/chat/completions`; optionally sends `x-opencode-session` |
| `anthropic` | browser → local proxy → `ANTHROPIC_UPSTREAM` | When the base URL is `https://api.anthropic.com`, the page switches to the local proxy automatically |
| `openai` | browser → your base URL directly | The upstream must allow CORS; the API key only lives in the browser |

In CC Switch mode, a provider is testable only when it has a base URL, a stored API key and a model catalog. OAuth-only providers are shown as unavailable.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Local server port |
| `HOST` | `127.0.0.1` | Bind address |
| `CC_SWITCH_ORIGIN` | `http://127.0.0.1:15721` | CC Switch local router |
| `CC_SWITCH_DB` | `~/.cc-switch/cc-switch.db` | CC Switch database path |
| `OPENCODE_UPSTREAM` | `https://opencode.ai/inference/go/openai/v1/chat/completions` | Upstream for `opencode-go` |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com/v1/messages` | Upstream for `anthropic` |
| `TPS_BENCH_UA` | `tps-bench/1.0` | User-Agent sent upstream |

### Optional: run at login on macOS

```bash
NODE_BIN=$(command -v node)
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__PROJECT_DIR__|$PWD|g" \
  deploy/com.tps-bench.proxy.plist.example \
  > ~/Library/LaunchAgents/com.tps-bench.proxy.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tps-bench.proxy.plist
```

Remove it with:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tps-bench.proxy.plist
rm ~/Library/LaunchAgents/com.tps-bench.proxy.plist
```

Logs go to `/tmp/tps-bench-proxy.log` and `/tmp/tps-bench-proxy.error.log`.

### Privacy and security

- The proxy binds to `127.0.0.1` by default. Do not switch it to `0.0.0.0` on an untrusted network.
- No telemetry or analytics. The page only talks to the endpoints you configure.
- Settings and history live in this browser's localStorage.
- The CC Switch database is opened read-only; credentials never leave the local proxy process.
- Benchmarks consume real API quota — set round counts and token limits accordingly.

### Project layout

```
tps-bench/
├── tps-bench.html                      # single-page UI and app logic
├── opencode-proxy.mjs                  # local proxy + static file server
├── basecoat.css                        # Tailwind CSS build
├── deploy/com.tps-bench.proxy.plist.example
├── package.json
└── LICENSE
```

### License

[MIT](LICENSE). `basecoat.css` is a Tailwind CSS v4.3.1 build (MIT).
