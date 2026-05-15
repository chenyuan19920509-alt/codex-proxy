<div align="center">

# Codex Proxy

### 用任意大模型跑 Codex CLI，成本直降 30-50x

Zero dependencies · Pure Node.js · One file

---

**DeepSeek · GLM · Qwen · NVIDIA NIM · Ollama · 任何 OpenAI 兼容 API**

</div>

---

## 它干嘛的

Codex CLI 只说 Responses API，其他模型只说 Chat Completions API。这个 proxy 是个翻译器，让它们能对话。

## 为什么要用这个

Codex 自带 `wire_api = "chat"` 支持已经被移除了（v0.130+）。直连第三方 API？不行。其他翻译代理？大多是 Python/Flask 单文件，没有消息压缩、没有工具过滤、没有容错。

这个 proxy 是**生产级的翻译层**——在 Codex 和上游模型之间处理所有边界情况：

- **长上下文自动压缩** — Codex 初始化会塞 200KB+ 的 system prompt（AGENTS.md + 项目文件），小模型和免费 API 直接超时。Proxy 自动裁剪到 token 预算内。
- **弱模型工具过滤** — 小参数模型用不好 `apply_patch`、`spawn_agent` 这些重工具，Proxy 自动移除，让它专注 read/write/exec。
- **模型降级** — 主模型 5xx/429？自动切到 fallback 模型继续跑。
- **HTTP 代理隧道** — 中国大陆用户设 `PROXY_OUTBOUND`，走 CONNECT 隧道连上游，不需要系统级代理。
- **零依赖** — 一个 `proxy.js` 文件，570 行，纯 Node.js 原生模块，没有 npm install。

## 省多少

| 模型 | 每百万 token | vs 官方 |
|------|-------------|--------|
| GPT-5.5 官方 | $15-30 | 基准 |
| DeepSeek V4 Pro | ~$0.5 | 30-50x |
| NVIDIA NIM (GLM-5.1 等) | **免费** | ∞ |
| 本地 Ollama | **免费** | ∞ |

> Codex 的工具调用、沙盒、上下文管理都在客户端，proxy 只做协议翻译，不影响功能。

## 30 秒上手

```bash
git clone https://github.com/chenyuan19920509-alt/codex-proxy.git
cd codex-proxy
cp .env.example .env   # 编辑填你的 key
node proxy.js
```

然后配 Codex：

```toml
# ~/.codex/config.toml
model_provider = "custom"
model = "deepseek-v4-pro"

[model_providers.custom]
base_url = "http://127.0.0.1:4446/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
requires_openai_auth = true
```

```bash
codex
```

## 常用上游

**DeepSeek：**
```bash
PROXY_UPSTREAM=https://api.deepseek.com  PROXY_API_KEY=sk-xxx  PROXY_MODEL=deepseek-v4-pro  node proxy.js
```

**NVIDIA NIM（免费）：**
```bash
PROXY_UPSTREAM=https://integrate.api.nvidia.com/v1  PROXY_API_KEY=nvapi-xxx  PROXY_MODEL=z-ai/glm-5.1  node proxy.js
```

**Ollama 本地：**
```bash
PROXY_UPSTREAM=http://localhost:11434/v1  PROXY_API_KEY=ollama  PROXY_MODEL=qwen3:32b  node proxy.js
```

**中国大陆加代理：**
```bash
PROXY_OUTBOUND=http://127.0.0.1:7897  node proxy.js
```

## 配置

| 变量 | 说明 | 默认 |
|------|------|------|
| `PROXY_PORT` | 监听端口 | `4446` |
| `PROXY_UPSTREAM` | 上游 API 地址 | 必填 |
| `PROXY_API_KEY` | 上游 Key | 必填 |
| `PROXY_MODEL` | 模型名 | 必填 |
| `PROXY_MAX_BODY_TOKENS` | Token 预算（控制压缩） | `262144` |
| `PROXY_OUTBOUND` | 出站代理 | 空 |
| `PROXY_FALLBACK` | 降级模型列表 | 空 |
| `REMOVE_TOOLS` | 强制移除的工具 | `apply_patch,spawn_agent,...` |

优先级：环境变量 > `~/.config/codex-proxy/config` > `.env` > 默认值

## 核心机制

### 消息压缩

`PROXY_MAX_BODY_TOKENS` 控制总 token 预算。超出时：
1. 裁剪 system prompt（instructions）到 `(MAX - 5000) * 4` 字符
2. 保留最近 6 条非 system 消息，丢弃更早的
3. 始终保留 tool 消息

设 `PROXY_MAX_BODY_TOKENS=32000` 可适配免费 API 的上下文限制。

### 工具过滤

- `apply_patch` 始终移除（弱模型格式差，用 read/write 更可靠）
- `MAX_BODY_TOKENS < 16000` 时自动移除 agent 管理工具
- `REMOVE_TOOLS` 可自定义黑名单

### 模型降级

```bash
PROXY_FALLBACK=deepseek-v4-flash,qwen3:14b
```

主模型挂了自动切备选，不中断任务。

### 代理隧道

设 `PROXY_OUTBOUND=http://host:port`，proxy 通过 HTTP CONNECT 建 TLS 隧道。不依赖系统代理设置，也不需要 `HTTPS_PROXY` 环境变量。

## 常见问题

**Codex 报 `wire_api = "chat" is no longer supported`**
→ v0.130+ 只认 responses。必须用 proxy 翻译。

**Codex 报 `Model metadata not found`**
→ config.toml 加：
```toml
[model_metadata."your-model"]
context_length = 131072
can_stream = true
supports_tools = true
```

**大请求超时**
→ 降 `PROXY_MAX_BODY_TOKENS=32000` 触发自动压缩。

**回复 "Ready." 而非真实内容**
→ 更新 proxy.js 到最新版（已修 Responses API 字符串 input bug）。

## 一键安装

```bash
./scripts/install.sh
```

管理命令：
```bash
./scripts/proxy-ctl start|stop|restart|status|health|log
```

## Docker

```bash
docker build -t codex-proxy .
docker run -p 4446:4446 --env-file .env codex-proxy
```

## 文件结构

```
proxy.js              # 代理主程序（零依赖）
scripts/install.sh    # 一键安装
scripts/proxy-ctl     # 进程管理
models/template.conf  # 配置模板
Dockerfile            # 容器镜像
.env.example          # 环境变量模板
```

## 许可证

MIT
