# Codex Proxy

A lightweight translation layer that converts **OpenAI Responses API** requests into **Chat Completions** format, so tools expecting the Responses API can work with any upstream Chat Completions-compatible provider.

## What It Does

- Accepts Responses API–style requests on a local port
- Translates them into Chat Completions requests for the upstream provider
- Streams the upstream SSE response back as Responses API events
- Handles tool calls, reasoning/thinking content, and context window management

## Quick Start

```bash
cp .env.example .env
# Edit .env with your upstream details
node proxy.js
```

Or use the installer:

```bash
./scripts/install.sh
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PROXY_PORT` | Local listen port | `4446` |
| `PROXY_UPSTREAM` | Upstream Chat Completions base URL | *(required)* |
| `PROXY_API_KEY` | API key for upstream | *(required)* |
| `PROXY_MODEL` | Model identifier sent upstream | *(required)* |

Priority: env vars > `~/.config/codex-proxy/config` > `.env` > defaults.

## Files

- `proxy.js` — the translation proxy server
- `scripts/install.sh` — one-click installer
- `scripts/proxy-ctl` — start/stop/restart/status CLI
- `models/template.conf` — configuration template
- `Dockerfile` — container image definition
