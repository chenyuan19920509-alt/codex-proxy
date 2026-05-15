#!/usr/bin/env node
const http = require("http");
const https = require("https");

// ── Config: env vars > ~/.config/codex-proxy/config > .env > defaults ──
const fs = require("fs");
const os = require("os");
const path = require("path");

function loadConfig() {
  const cfg = {};
  // Layer 1: defaults (Ubuntu native)
  cfg.PROXY_PORT = 4446;
  cfg.PROXY_UPSTREAM = "https://api.example.com/v1";
  cfg.PROXY_MODEL = "gpt-4o";
  cfg.PROXY_MAX_BODY_TOKENS = 1048576;
  cfg.REMOVE_TOOLS = "apply_patch";
  cfg.REMOVE_AGENT_TOOLS = "spawn_agent,send_input,wait_agent";

  // Layer 2: .env in cwd
  const envFile = path.join(process.cwd(), ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)/);
      if (m) cfg[m[1]] = m[2].trim();
    }
  }

  // Layer 3: ~/.config/codex-proxy/config (KEY=VALUE format)
  const userCfg = path.join(os.homedir(), ".config", "codex-proxy", "config");
  if (fs.existsSync(userCfg)) {
    for (const line of fs.readFileSync(userCfg, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)/);
      if (m) cfg[m[1]] = m[2].trim();
    }
  }

  // Layer 4: env vars (highest priority)
  for (const k of ["PROXY_PORT","PROXY_UPSTREAM","PROXY_API_KEY","PROXY_MODEL","PROXY_MAX_BODY_TOKENS"]) {
    if (process.env[k]) cfg[k] = process.env[k];
  }

  for (const k of ["REMOVE_TOOLS", "REMOVE_AGENT_TOOLS"]) {
    if (process.env[k]) cfg[k] = process.env[k];
  }

  return cfg;
}

const C = loadConfig();

// ── Outbound proxy for international APIs ──
const OUTBOUND_PROXY = process.env.PROXY_OUTBOUND || "";

function createProxyAgent() {
  if (!OUTBOUND_PROXY) return undefined;
  const pu = new URL(OUTBOUND_PROXY);
  const net = require("net");
  const tls = require("tls");
  class ProxyAgent extends https.Agent {
    createConnection(opts, cb) {
      const socket = net.createConnection(pu.port || 3128, pu.hostname, () => {
        socket.write(`CONNECT ${opts.hostname || opts.host}:${opts.port} HTTP/1.1\r\nHost: ${opts.hostname || opts.host}:${opts.port}\r\n\r\n`);
        socket.once("data", (d) => {
          const code = parseInt(d.toString().split(" ")[1]);
          if (code !== 200) { socket.destroy(); cb(new Error("proxy CONNECT failed: " + code)); return; }
          const tlsSocket = tls.connect({ socket, servername: opts.servername || opts.hostname || opts.host, ALPNProtocols: ["http/1.1"] }, () => cb(null, tlsSocket));
          tlsSocket.on("error", (e) => cb(e));
        });
      });
      socket.on("error", (e) => cb(e));
    }
  }
  return new ProxyAgent();
}
const PORT = +C.PROXY_PORT;
const UPSTREAM = C.PROXY_UPSTREAM;
const API_KEY = C.PROXY_API_KEY || "";
const MODEL = C.PROXY_MODEL;
const MAX_BODY_TOKENS = parseInt(C.PROXY_MAX_BODY_TOKENS || "262144", 10);
const MAX_INSTRUCTION_CHARS = Math.max(2000, (MAX_BODY_TOKENS - 5000) * 4);
const FALLBACKS = (process.env.PROXY_FALLBACK || "").split(",").map(s => s.trim()).filter(Boolean);

// ── Native language note: tell the model in its mother tongue ──
const SAFETY_NOTE = "When writing bash scripts with `set -e`, use `N=$((N+1))` instead of `((N++))`, because `((0))` exits 1 in bash.";

function estimateTokens(msg) {
  let chars = 0;
  if (typeof msg.content === "string") chars += msg.content.length;
  if (msg.tool_calls) for (const tc of msg.tool_calls) chars += JSON.stringify(tc).length;
  return Math.ceil(chars / 4);
}

function compressMessages(msgs, maxTokens) {
  const threshold = Math.floor(maxTokens * 0.8);
  let total = msgs.reduce((s, m) => s + estimateTokens(m), 0);
  if (total <= threshold) return msgs;

  const systemMsg = msgs.find(m => m.role === "system");
  const nonSystem = msgs.filter(m => m.role !== "system");

  // Keep: last 6 non-system messages. Drop older ones.
  // Always preserve tool messages (role === "tool") near the end.
  const keep = Math.min(6, nonSystem.length);
  const trimmed = nonSystem.slice(-keep);

  const result = systemMsg ? [systemMsg, ...trimmed] : trimmed;
  const newTotal = result.reduce((s, m) => s + estimateTokens(m), 0);
  const dropped = msgs.length - result.length;
  if (dropped > 0) console.error(`[${ts()}] compress: ${msgs.length}→${result.length} msgs, ${total}→${newTotal} est tokens`);

  return result;
}

// ── buildMessages: Responses API input → Chat Completions messages ──
function buildMessages(input, instructions) {
  const msgs = [];
  if (instructions) {
    const combined = instructions + "\n" + SAFETY_NOTE;
    const trimmed = combined.length > MAX_INSTRUCTION_CHARS
      ? combined.slice(0, MAX_INSTRUCTION_CHARS)
      : combined;
    msgs.push({ role: "system", content: trimmed });
  }

  // Responses API allows input as a plain string
  if (typeof input === "string") {
    msgs.push({ role: "user", content: input });
    return msgs;
  }

  if (!Array.isArray(input)) return msgs;

  for (const item of input) {
    if (item.type === "message") {
      let content = "";
      if (Array.isArray(item.content)) {
        content = item.content
          .filter(c => c.type === "input_text" || c.type === "output_text")
          .map(c => c.text || "")
          .join("\n");
      } else if (typeof item.content === "string") {
        content = item.content;
      }
      if (!content.trim()) continue;
      const role = item.role === "assistant" ? "assistant"
        : item.role === "developer" ? "system"
        : "user";
      msgs.push({ role, content });
    } else if (item.type === "function_call") {
      msgs.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || "call_1",
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        }],
      });
    } else if (item.type === "function_call_output") {
      msgs.push({
        role: "tool",
        tool_call_id: item.call_id || "call_1",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || {}),
      });
    }
  }
  return msgs;
}

// ── translateTools: Responses API tools → Chat Completions tools ──
function translateTools(tools) {
  if (!tools || !tools.length) return undefined;
  // Drop apply_patch — weak models can't format unified diff.
  // They naturally use read/write/exec_command(echo) as their "universal language".
  const removeTools = new Set((C.REMOVE_TOOLS || "").split(",").filter(t => t));
  const removeAgentTools = new Set((C.REMOVE_AGENT_TOOLS || "").split(",").filter(t => t));
  const skipHeavy = MAX_BODY_TOKENS < 16000;
  return tools
    .filter(t => {
      if (t.type !== "function" || !t.name) return false;
      if (removeTools.has(t.name)) return false; // always skip — configurable
      if (skipHeavy && removeAgentTools.has(t.name)) return false; // conditionally skip — configurable
      return true;
    })
    .map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ? t.description.slice(0, 500) : "",
        parameters: t.parameters || { type: "object", properties: {} },
      },
    }));
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Simple concurrency limiter — prevent upstream 429s
let activeUpstream = 0;
let totalRequests = 0;
let errors5xx = 0;
const MAX_CONCURRENT = process.env.PROXY_CONCURRENT ? parseInt(process.env.PROXY_CONCURRENT) : 6;
const pendingQueue = [];

function acquireSlot(cb) {
  if (activeUpstream < MAX_CONCURRENT) { activeUpstream++; cb(); }
  else pendingQueue.push(cb);
}
function releaseSlot() {
  activeUpstream--;
  if (pendingQueue.length) { activeUpstream++; pendingQueue.shift()(); }
}

// ── Model capability probe — runs at startup ──
let modelCaps = { thinking: false, tools: false, probed: false };

function runProbe() {
  const upstreamUrl = new URL(UPSTREAM);
  const client = upstreamUrl.protocol === "https:" ? https : http;
  const probeBody = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "What is 247*89? Use the calc tool." }],
    stream: true, max_tokens: 100,
    tools: [{ type: "function", function: { name: "calc", description: "Calculate a math expression", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } } }],
  });
  const opts = {
    hostname: upstreamUrl.hostname, port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
    path: upstreamUrl.pathname + "/chat/completions", method: "POST", timeout: 15000,
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(probeBody), Authorization: `Bearer ${API_KEY}`, Accept: "application/json, text/event-stream" },
  };
  const req = client.request(opts, (res) => {
    let data = "";
    res.on("data", (c) => data += c);
    res.on("end", () => {
      modelCaps.thinking = /"reasoning_content":"[^"]+"/.test(data);
      modelCaps.tools = /"tool_calls":\s*\[/.test(data);
      modelCaps.probed = true;
      console.error(`[${ts()}] probe: thinking=${modelCaps.thinking} tools=${modelCaps.tools}`);
    });
  });
  req.on("error", () => { modelCaps.probed = true; });
  req.write(probeBody);
  req.end();
}

function proxy(cReq, cRes) {
  totalRequests++;
  console.error(`[${ts()}] ${cReq.method} ${cReq.url}`);
  const MAX_BODY = 512 * 1024;
  const chunks = [];
  let bodyTooLarge = false;
  let bodyLen = 0;

  cReq.on("data", (c) => {
    chunks.push(c);
    bodyLen += c.length;
    if (bodyLen > MAX_BODY && !bodyTooLarge) {
      bodyTooLarge = true;
      cRes.writeHead(413, { "Content-Type": "application/json" });
      cRes.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Request body too large. Max 512KB." } }));
      cReq.destroy();
    }
  });

  cReq.on("end", () => {
    if (bodyTooLarge) return;
    const body = Buffer.concat(chunks).toString();
    const upstreamUrl = new URL(UPSTREAM);
    const client = upstreamUrl.protocol === "https:" ? https : http;
    let path = cReq.url;
    let upstreamBody = body;

    if (path === "/health") {
      cRes.writeHead(200, { "Content-Type": "application/json" });
      cRes.end(JSON.stringify({
        status: "ok", uptime: process.uptime(), backend: UPSTREAM, model: MODEL,
        caps: modelCaps, max_body_tokens: MAX_BODY_TOKENS, max_concurrent: MAX_CONCURRENT
      }));
      return;
    }

    if (path === "/metrics") {
      cRes.writeHead(200, { "Content-Type": "application/json" });
      cRes.end(JSON.stringify({ uptime: process.uptime(), total_requests: totalRequests, active_requests: activeUpstream, errors_5xx: errors5xx }));
      return;
    }

    if (path === "/probe") {
      cRes.writeHead(200, { "Content-Type": "application/json" });
      cRes.end(JSON.stringify(modelCaps));
      return;
    }

    if (path === "/v1/models") {
      cRes.writeHead(200, { "Content-Type": "application/json" });
      cRes.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 1, owned_by: "proxy" }] }));
      return;
    }

    // Always use configured model — ignore client model
    const effectiveModel = MODEL;

    if (path === "/v1/responses" && body) {
      try {
        const r = JSON.parse(body);
        const msgsRaw = buildMessages(r.input, r.instructions);
        const msgs = compressMessages(msgsRaw, MAX_BODY_TOKENS);
        const tools = translateTools(r.tools);

        // Empty input → send quick ACK so Codex doesn't hang
        const userMsgs = msgs.filter(m => m.role !== "system" && m.content);
        if (userMsgs.length === 0 && (!tools || !tools.length)) {
          const rid = "resp_" + Math.random().toString(36).slice(2, 10);
          const mid = "msg_" + Math.random().toString(36).slice(2, 6);
        let headersSent = false;
          cRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        headersSent = true;
          function emit(t, d) { cRes.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`); }
          emit("response.created", { type: "response.created", response: { id: rid, object: "response", model: effectiveModel, status: "in_progress", created_at: Math.floor(Date.now() / 1000), output: [] } });
          emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: mid, type: "message", role: "assistant", status: "in_progress", content: [] } });
          emit("response.content_part.added", { type: "response.content_part.added", item_id: mid, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          emit("response.output_text.delta", { type: "response.output_text.delta", item_id: mid, output_index: 0, content_index: 0, delta: "Ready." });
          emit("response.output_text.done", { type: "response.output_text.done", item_id: mid, output_index: 0, content_index: 0, text: "Ready." });
          emit("response.content_part.done", { type: "response.content_part.done", item_id: mid, output_index: 0, content_index: 0, part: { type: "output_text", text: "Ready.", annotations: [] } });
          emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: mid, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Ready.", annotations: [] }] } });
          emit("response.completed", { type: "response.completed", response: { id: rid, object: "response", model: effectiveModel, status: "completed", created_at: Math.floor(Date.now() / 1000), output: [{ id: mid, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Ready.", annotations: [] }] }], usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } });
          cRes.end();
          return;
        }

        console.error(`[${ts()}] msgs:${msgs.length} tools:${tools ? tools.length : 0} body:${body.length}B`);

        upstreamBody = JSON.stringify({
          model: effectiveModel,
          messages: msgs,
          stream: true,
          temperature: r.temperature || 0.2,
          top_p: r.top_p || 0.95,
          max_tokens: r.max_output_tokens || 32000,
          tools: tools,
          tool_choice: tools ? "auto" : undefined,
        });
      } catch (e) { console.error(`[${ts()}] parse error:`, e.message); }
      path = upstreamUrl.pathname + "/chat/completions";
    } else {
      path = upstreamUrl.pathname + path.replace(/^\/v1/, "");
    }

    const opts = {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      path, method: cReq.method, timeout: 120000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(upstreamBody), Authorization: `Bearer ${API_KEY}`, "HTTP-Referer": "http://localhost", "X-Title": "codex-proxy", Accept: "application/json, text/event-stream" },
      agent: createProxyAgent(),
    };

    let attempt = 0;
    let fallbackIdx = 0;
    let clientHeadersSent = false;
    const allModels = [effectiveModel, ...FALLBACKS];
    const MAX_RETRIES = 2;
    const BACKOFF = [300, 900, 2000];

    function doUpstream() {
      acquireSlot(() => {
      attempt++;
      const curModel = allModels[fallbackIdx] || effectiveModel;
      // Update body with current model when switching fallbacks
      if (fallbackIdx > 0) {
        try {
          const b = JSON.parse(upstreamBody);
          b.model = curModel;
          upstreamBody = JSON.stringify(b);
          opts.headers["Content-Length"] = Buffer.byteLength(upstreamBody);
        } catch (e) { console.error(`[${ts()}] fallback model parse error: ${e.message}`); }
      }
      const upReq = client.request(opts, (uRes) => {
        if ((uRes.statusCode >= 500 || uRes.statusCode === 429) && attempt <= MAX_RETRIES) {
          if (uRes.statusCode >= 500) errors5xx++;
          let errBody = "";
          uRes.on("data", (c) => errBody += c);
          uRes.on("end", () => {
            const delay = BACKOFF[attempt - 1] || 300;
            console.error(`[${ts()}] ${curModel} upstream ${uRes.statusCode} retry ${attempt}/${MAX_RETRIES} in ${delay}ms:`, errBody.slice(0, 120));
            releaseSlot();
            setTimeout(doUpstream, delay);
          });
          return;
        }
        if ((uRes.statusCode === 429 || uRes.statusCode >= 500) && fallbackIdx + 1 < allModels.length) {
          fallbackIdx++;
          attempt = 0;
          let errBody = "";
          uRes.on("data", (c) => errBody += c);
          uRes.on("end", () => {
            console.error(`[${ts()}] ${curModel} failed, fallback to ${allModels[fallbackIdx]}`);
            releaseSlot();
            setTimeout(doUpstream, 100);
          });
          return;
        }

        const isSSE = (uRes.headers["content-type"] || "").includes("text/event-stream");

        if (!isSSE) {
          const rc = [];
          uRes.on("data", (c) => rc.push(c));
          uRes.on("end", () => {
            const rawBody = Buffer.concat(rc).toString();
            if (uRes.statusCode >= 400) {
              console.error(`[${ts()}] upstream ${uRes.statusCode}:`, rawBody.slice(0, 200));
              cRes.writeHead(uRes.statusCode, { "Content-Type": "application/json" });
              cRes.end(rawBody);
              releaseSlot(); return;
            }
            try {
              const chat = JSON.parse(rawBody);
              const ch = chat.choices?.[0]?.message;
              const out = {
                id: chat.id, object: "response", status: "completed",
                model: chat.model, created_at: Math.floor(Date.now() / 1000),
                output: [],
                usage: { input_tokens: chat.usage?.prompt_tokens || 0, output_tokens: chat.usage?.completion_tokens || 0, total_tokens: chat.usage?.total_tokens || 0 },
              };
              if (ch?.content) out.output.push({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: ch.content, annotations: [] }] });
              if (ch?.tool_calls) for (const tc of ch.tool_calls) out.output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments, status: "completed" });
              cRes.writeHead(uRes.statusCode, { "Content-Type": "application/json" });
              cRes.end(JSON.stringify(out));
              releaseSlot();
            } catch (e) { console.error(`[${ts()}] upstream error:`, e.message); cRes.writeHead(uRes.statusCode); cRes.end(Buffer.concat(rc)); releaseSlot(); }
          });
          return;
        }

        // ── SSE Streaming ──
        cRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        clientHeadersSent = true;
        const rid = "resp_" + Math.random().toString(36).slice(2, 10);
        let buf = "", started = false, messageStarted = false, text = "", reasoning = "", thinkingEmitted = false, usage = null;
        const tcMap = {};
        const tcList = [];

        function emit(t, d) { cRes.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`); }

        function ensureMessageStarted() {
          if (messageStarted) return;
          messageStarted = true;
          emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", status: "in_progress", role: "assistant", content: [] } });
          emit("response.content_part.added", { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        }

        uRes.on("data", (d) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const l of lines) {
            if (!l.startsWith("data: ")) continue;
            if (l.slice(6) === "[DONE]") continue;
            try {
              const ev = JSON.parse(l.slice(6));
              const ch = ev.choices?.[0];
              const delta = ch?.delta || {};

              if (!started) {
                started = true;
                emit("response.created", { type: "response.created", response: { id: rid, object: "response", model: effectiveModel, status: "in_progress", created_at: Math.floor(Date.now() / 1000), output: [] } });
                emit("response.in_progress", { type: "response.in_progress", response_id: rid });
              }

              // ensureMessageStarted moved outside data handler for end handler access

              // Collect reasoning from thinking models (different APIs use different field names)
              const think = delta.reasoning_content || delta.reasoning || "";
              if (think) reasoning += think;

              if (delta.content) {
                ensureMessageStarted();
                // Prepend reasoning as a code-fenced block on first real content
                if (reasoning && !thinkingEmitted) {
                  thinkingEmitted = true;
                  const thinkBlock = "<thinking>\n" + reasoning + "\n</thinking>\n\n";
                  text = thinkBlock + delta.content;
                  emit("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: thinkBlock + delta.content });
                } else {
                  text += delta.content;
                  emit("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: delta.content });
                }
              }

              if (delta.tool_calls) for (const tc of delta.tool_calls) {
                const idx = tc.index || 0;
                if (!tcMap[idx]) { const t = { id: tc.id || ("call_" + idx), name: "", args: "", outputIndex: 1 + tcList.length, added: false }; tcMap[idx] = t; tcList.push(t); }
                const cur = tcMap[idx];
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) {
                  cur.name = tc.function.name;
                  if (!cur.added) {
                    cur.added = true;
                    emit("response.output_item.added", { type: "response.output_item.added", output_index: cur.outputIndex, item: { type: "function_call", id: cur.id, call_id: cur.id, name: cur.name, arguments: "", status: "in_progress" } });
                  }
                }
                if (tc.function?.arguments) {
                  cur.args += tc.function.arguments;
                  emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: cur.id, output_index: cur.outputIndex, delta: tc.function.arguments });
                }
              }

              if (ch?.finish_reason) usage = ev.usage;
            } catch (e) { console.error(`[${ts()}] sse parse:`, e.message); }
          }
        });

        uRes.on("end", () => {
          // If thinking model had reasoning but no text content, emit it now
          if (reasoning && !thinkingEmitted) {
            ensureMessageStarted();
            text = "<thinking>\n" + reasoning + "\n</thinking>";
            emit("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text });
          }
          if (text) {
            emit("response.output_text.done", { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text });
            emit("response.content_part.done", { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } });
          }
          if (messageStarted) emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", status: "completed", role: "assistant", content: text ? [{ type: "output_text", text, annotations: [] }] : [] } });
          const outItems = text ? [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] : [];
          for (let i = 0; i < tcList.length; i++) {
            const tc = tcList[i];
            const oi = tc.outputIndex;
            if (!tc.added) emit("response.output_item.added", { type: "response.output_item.added", output_index: oi, item: { type: "function_call", id: tc.id, call_id: tc.id, name: tc.name, arguments: "", status: "in_progress" } });
            emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: tc.id, output_index: oi, arguments: tc.args });
            emit("response.output_item.done", { type: "response.output_item.done", output_index: oi, item: { type: "function_call", id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.args, status: "completed" } });
            outItems.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.args, status: "completed" });
          }
          emit("response.completed", { type: "response.completed", response: { id: rid, object: "response", model: effectiveModel, status: "completed", created_at: Math.floor(Date.now() / 1000), output: outItems, usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0, total_tokens: usage?.total_tokens || 0 } } });
          cRes.end();
          releaseSlot();
        });
        uRes.on("error", (e) => {
          if (clientHeadersSent) { console.error(`[${ts()}] upstream res error after headers sent, not retrying:`, e.message); cRes.end(); releaseSlot(); }
          else if (attempt <= MAX_RETRIES) { const delay = BACKOFF[attempt - 1] || 300; console.error(`[${ts()}] upstream res error retry ${attempt} in ${delay}ms:`, e.message); releaseSlot(); setTimeout(doUpstream, delay); }
          else { cRes.end(); releaseSlot(); }
        });
      });

      upReq.on("error", (e) => {
        if (clientHeadersSent) { console.error(`[${ts()}] upstream error after headers sent, not retrying:`, e.message); cRes.end(); releaseSlot(); return; }
        if (attempt <= MAX_RETRIES) { const delay = BACKOFF[attempt - 1] || 300; console.error(`[${ts()}] upstream req error retry ${attempt} in ${delay}ms:`, e.message); releaseSlot(); setTimeout(doUpstream, delay); }
        else { cRes.writeHead(502); cRes.end(JSON.stringify({ error: e.message })); releaseSlot(); }
      });
      upReq.write(upstreamBody);
      upReq.end();
    });
    }

    doUpstream();
  });
}

// ── Global error handlers — prevent crash on unhandled errors ──
process.on("uncaughtException", (err) => {
  console.error(`[${ts()}] UNCAUGHT:`, err.message, err.stack?.split("\n")[1] || "");
});
process.on("unhandledRejection", (reason) => {
  console.error(`[${ts()}] UNHANDLED_REJECTION:`, reason?.message || reason);
});

http.createServer(proxy).listen(PORT, "0.0.0.0", () => {
  console.log(`[${ts()}] proxy :${PORT} → ${UPSTREAM}`);
  runProbe();
});
