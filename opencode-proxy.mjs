#!/usr/bin/env node
/**
 * TPS Bench - local API proxy.
 *
 * Run:
 *   node opencode-proxy.mjs
 * Then open:
 *   http://127.0.0.1:8787/
 *
 * CC Switch access is read-only. Credentials stay inside this process and are
 * never returned to the browser or written to logs.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "tps-bench.html");
const basecoatPath = join(here, "basecoat.css");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const OPENCODE_UPSTREAM = process.env.OPENCODE_UPSTREAM || "https://opencode.ai/inference/go/openai/v1/chat/completions";
const ANTHROPIC_UPSTREAM = process.env.ANTHROPIC_UPSTREAM || "https://api.anthropic.com/v1/messages";
const CC_SWITCH_ORIGIN = process.env.CC_SWITCH_ORIGIN || "http://127.0.0.1:15721";
const CC_SWITCH_DB = process.env.CC_SWITCH_DB || join(homedir(), ".cc-switch", "cc-switch.db");
const USER_AGENT = process.env.TPS_BENCH_UA || "tps-bench/1.0";
const fallbackSession = `ses_${randomBytes(13).toString("hex")}`;
const allowedCcOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const RUN_TTL_MS = 30 * 60 * 1000;
const MAX_RUNS = 32;
const providerRuns = new Map();

const PROVIDER_APPS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" }
];
const APP_NAMES = new Map(PROVIDER_APPS.map((app) => [app.id, app.name]));
const API_FORMATS = new Set(["anthropic", "openai_chat", "openai_responses"]);

const ccCorsHeaders = {
  "Access-Control-Allow-Origin": `http://127.0.0.1:${PORT}`,
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "content-type, accept",
  "Access-Control-Max-Age": "86400"
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "authorization, content-type, accept, x-opencode-session, x-bench-session, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
  "Access-Control-Expose-Headers": "x-opencode-session, request-id, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-tokens-remaining",
  "Access-Control-Max-Age": "86400"
};

function ccOriginAllowed(req) {
  const origin = req.headers.origin;
  return !origin || allowedCcOrigins.has(origin);
}

function endJson(res, status, payload, headers = corsHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, limit = 256 * 1024) {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch (_) {
    throw Object.assign(new Error("请求体必须是 JSON。"), { statusCode: 400 });
  }
}

function sessionFrom(req) {
  const supplied = req.headers["x-opencode-session"] || req.headers["x-bench-session"];
  const session = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!session) return fallbackSession;
  return String(session).trim() || fallbackSession;
}

async function servePage(res) {
  try {
    const html = await readFile(pagePath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.length,
      "Cache-Control": "no-store"
    });
    res.end(html);
  } catch (error) {
    endJson(res, 500, { error: { message: `Cannot read tps-bench.html: ${error.message}` } });
  }
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function tomlValue(toml, key) {
  if (typeof toml !== "string") return "";
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = toml.match(new RegExp(`^\\s*${escaped}\\s*=\\s*["']([^"']+)["']`, "m"));
  return match ? match[1].trim() : "";
}

function normalizeModelId(value) {
  return String(value || "").trim().replace(/\s*\[1M\]\s*$/i, "");
}

function addModel(models, rawId, rawName = "") {
  const id = normalizeModelId(rawId);
  if (!id || id.length > 300) return;
  const name = String(rawName || id).trim() || id;
  const existing = models.find((model) => model.id === id);
  if (!existing) models.push({ id, name });
  else if (name && name !== id && existing.name === id) existing.name = name;
}

function extractClaudeModels(env) {
  const models = [];
  const priority = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL"
  ];
  for (const key of priority) {
    const model = env[key];
    if (!model) continue;
    const name = env[`${key}_NAME`] || env[key.replace(/_MODEL$/, "_MODEL_NAME")] || "";
    addModel(models, model, name || model);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/_MODEL$/.test(key) || key.startsWith("ANTHROPIC_DEFAULT_") || key === "ANTHROPIC_MODEL") continue;
    addModel(models, value, env[`${key}_NAME`] || value);
  }
  return models;
}

function modelCatalogEntries(value) {
  const parsed = parseJsonObject(value, null);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.models)) return parsed.models;
  if (Array.isArray(parsed.data)) return parsed.data;
  return [];
}

function extractCodexModels(toml, catalogValue) {
  const models = [];
  addModel(models, tomlValue(toml, "model"), tomlValue(toml, "model"));
  for (const item of modelCatalogEntries(catalogValue)) {
    if (!item || typeof item !== "object") continue;
    const id = item.model || item.slug || item.id || item.name;
    const name = item.displayName || item.display_name || item.name || id;
    addModel(models, id, name);
  }
  return models;
}

function extractRouterModels(payload) {
  const models = [];
  const entries = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  for (const item of entries) {
    if (typeof item === "string") addModel(models, item, item);
    else if (item && typeof item === "object") addModel(models, item.slug || item.id || item.name, item.display_name || item.displayName || item.name);
  }
  return models;
}

async function fetchRouterModels() {
  try {
    const response = await fetch(`${CC_SWITCH_ORIGIN}/v1/models`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) return [];
    return extractRouterModels(await response.json());
  } catch (_) {
    return [];
  }
}

function inferApiFormat(appType, meta, toml = "") {
  if (API_FORMATS.has(meta.apiFormat)) return meta.apiFormat;
  const wireApi = tomlValue(toml, "wire_api").toLowerCase();
  if (wireApi === "responses") return "openai_responses";
  if (wireApi === "chat" || wireApi === "chat_completions") return "openai_chat";
  return appType === "claude" ? "anthropic" : "openai_responses";
}

function credentialHeaders(appType, settings) {
  const env = settings.env && typeof settings.env === "object" ? settings.env : {};
  const auth = settings.auth && typeof settings.auth === "object" ? settings.auth : {};
  if (appType === "claude") {
    const bearer = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
    const apiKey = env.ANTHROPIC_API_KEY || "";
    return {
      hasCredential: Boolean(bearer || apiKey),
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01"
      },
      secrets: [bearer, apiKey].filter(Boolean)
    };
  }
  const apiKey = auth.OPENAI_API_KEY || env.OPENAI_API_KEY || env.OPENAI_AUTH_TOKEN || "";
  return {
    hasCredential: Boolean(apiKey),
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    secrets: apiKey ? [apiKey] : []
  };
}

function buildUpstreamUrl(baseUrl, apiFormat, isFullUrl = false) {
  const base = String(baseUrl || "").trim();
  if (!base) return "";
  let url;
  try { url = new URL(base); } catch (_) { return ""; }
  if (isFullUrl) return url.toString();
  let path = url.pathname.replace(/\/+$/, "");
  const pathLower = path.toLowerCase();
  const suffixes = {
    anthropic: ["/messages", "/v1/messages"],
    openai_chat: ["/chat/completions", "/v1/chat/completions"],
    openai_responses: ["/responses", "/v1/responses"]
  }[apiFormat] || [];
  if (suffixes.some((suffix) => pathLower.endsWith(suffix))) return url.toString();
  if (/\/v\d+$/i.test(path)) path += suffixes[0];
  else path += suffixes[1];
  url.pathname = path || suffixes[1];
  return url.toString();
}

async function readCcSwitchData() {
  const providerSql = "SELECT id, app_type, name, settings_config, meta, is_current FROM providers WHERE app_type IN ('claude','codex') ORDER BY app_type, sort_index, name;";
  const endpointSql = "SELECT provider_id, app_type, url, added_at FROM provider_endpoints ORDER BY app_type, provider_id, added_at DESC;";
  const options = { encoding: "utf8", timeout: 6000, maxBuffer: 20 * 1024 * 1024 };
  let providersResult;
  try {
    providersResult = await execFileAsync("sqlite3", ["-readonly", "-json", CC_SWITCH_DB, providerSql], options);
  } catch (_) {
    throw Object.assign(new Error("无法只读打开 CC Switch 数据库。"), { statusCode: 503 });
  }
  let endpoints = [];
  try {
    const endpointResult = await execFileAsync("sqlite3", ["-readonly", "-json", CC_SWITCH_DB, endpointSql], options);
    endpoints = JSON.parse(endpointResult.stdout || "[]");
  } catch (_) {
    endpoints = [];
  }
  return {
    providers: JSON.parse(providersResult.stdout || "[]"),
    endpoints: Array.isArray(endpoints) ? endpoints : []
  };
}

function resolveProvider(record, endpoints, routerModels = []) {
  const settings = parseJsonObject(record.settings_config);
  const meta = parseJsonObject(record.meta);
  const env = settings.env && typeof settings.env === "object" ? settings.env : {};
  const auth = settings.auth && typeof settings.auth === "object" ? settings.auth : {};
  const appType = String(record.app_type || "");
  const providerId = String(record.id || "");
  const name = String(record.name || providerId);
  const toml = typeof settings.config === "string" ? settings.config : "";
  const apiFormat = inferApiFormat(appType, meta, toml);
  const credential = credentialHeaders(appType, settings);
  const endpointCandidates = endpoints
    .filter((item) => item && item.app_type === appType && item.provider_id === providerId)
    .map((item) => String(item.url || "").trim())
    .filter(Boolean);
  const baseUrl = String(
    appType === "claude"
      ? env.ANTHROPIC_BASE_URL || endpointCandidates[0] || ""
      : tomlValue(toml, "base_url") || endpointCandidates[0] || ""
  ).trim();
  let models = appType === "claude"
    ? extractClaudeModels(env)
    : extractCodexModels(toml, settings.modelCatalog);
  const isCurrent = Boolean(record.is_current);
  if (!models.length && isCurrent && routerModels.length) models = routerModels.map((model) => ({ ...model }));
  const upstreamUrl = buildUpstreamUrl(baseUrl, apiFormat, meta.isFullUrl === true);
  const unavailableReason = !baseUrl
    ? "未找到 Base URL"
    : !credential.hasCredential
      ? "仅支持 OAuth 登录"
      : !models.length
        ? "未找到模型目录"
        : !upstreamUrl
          ? "Base URL 无效"
          : "";
  return {
    public: {
      id: providerId,
      appType,
      name,
      apiFormat,
      baseUrl,
      isCurrent,
      testable: !unavailableReason,
      unavailableReason,
      models
    },
    internal: {
      id: providerId,
      appType,
      name,
      apiFormat,
      baseUrl,
      upstreamUrl,
      models,
      headers: credential.headers,
      secrets: credential.secrets
    }
  };
}

async function buildProviderCatalog() {
  const { providers, endpoints } = await readCcSwitchData();
  let resolved = providers.map((record) => resolveProvider(record, endpoints));
  const mayNeedRouterModels = resolved.some((item) => item.public.isCurrent && item.public.baseUrl && item.internal.secrets.length && !item.public.models.length);
  if (mayNeedRouterModels) {
    const routerModels = await fetchRouterModels();
    if (routerModels.length) resolved = providers.map((record) => resolveProvider(record, endpoints, routerModels));
  }
  const apps = PROVIDER_APPS.map((app) => ({
    ...app,
    providers: resolved
      .filter((item) => item.public.appType === app.id)
      .map((item) => item.public)
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name, "zh-CN"))
  }));
  return { apps, resolved };
}

function publicProviderCatalog(catalog) {
  return { apps: catalog.apps };
}

async function handleCcSwitchProviders(res, appType = "", providerId = "") {
  try {
    const catalog = await buildProviderCatalog();
    if (!appType) {
      endJson(res, 200, publicProviderCatalog(catalog), ccCorsHeaders);
      return;
    }
    const provider = catalog.resolved.find((item) => item.public.appType === appType && item.public.id === providerId);
    if (!provider) {
      endJson(res, 404, { error: { message: "未找到该 CC Switch 供应商。" } }, ccCorsHeaders);
      return;
    }
    endJson(res, 200, {
      appType,
      providerId,
      appTypeName: APP_NAMES.get(appType) || appType,
      provider: provider.public
    }, ccCorsHeaders);
  } catch (error) {
    endJson(res, error.statusCode || 503, {
      error: { message: error.message || "无法读取 CC Switch 配置。" }
    }, ccCorsHeaders);
  }
}

async function handleCcSwitchModels(req, res) {
  try {
    const upstream = await fetch(`${CC_SWITCH_ORIGIN}/v1/models`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000)
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      ...ccCorsHeaders,
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store"
    });
    res.end(text);
  } catch (error) {
    endJson(res, 502, {
      error: { message: `Cannot reach CC Switch local router at ${CC_SWITCH_ORIGIN}: ${error.message}` }
    }, ccCorsHeaders);
  }
}

function pruneProviderRuns() {
  const now = Date.now();
  for (const [key, run] of providerRuns) {
    if (now - run.createdAt > RUN_TTL_MS) providerRuns.delete(key);
  }
  while (providerRuns.size >= MAX_RUNS) providerRuns.delete(providerRuns.keys().next().value);
}

function buildProviderPayload(target, prompt, maxTokens, stream) {
  if (target.apiFormat === "anthropic") {
    return {
      model: target.model,
      max_tokens: maxTokens,
      stream,
      messages: [{ role: "user", content: prompt }],
      // Claude 5.x thinks by default and hides the thinking text, which can eat the whole
      // token budget before any visible output. Low effort keeps the benchmark about
      // generation speed rather than reasoning depth.
      ...(/^claude-/i.test(target.model) ? { output_config: { effort: "low" } } : {})
    };
  }
  if (target.apiFormat === "openai_responses") {
    return {
      model: target.model,
      input: prompt,
      max_output_tokens: maxTokens,
      stream
    };
  }
  return {
    model: target.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {})
  };
}

function responseHeadersForCc(upstream) {
  const headers = {
    ...ccCorsHeaders,
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no"
  };
  for (const name of ["request-id", "x-request-id", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-remaining"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch (_) { return ""; }
}

function redactSecrets(text, secrets) {
  let redacted = String(text || "");
  for (const secret of secrets || []) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

async function handleProviderRequest(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  let target = null;
  try {
    const body = await readJsonBody(req);
    const runId = String(body.runId || "");
    const appType = String(body.appType || "");
    const providerId = String(body.providerId || "");
    const model = String(body.model || "");
    const prompt = String(body.prompt || "");
    const maxTokens = Number(body.maxTokens);
    const stream = body.stream !== false;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(runId)) throw Object.assign(new Error("测速运行标识无效。"), { statusCode: 400 });
    if (!APP_NAMES.has(appType)) throw Object.assign(new Error("不支持的 CC Switch 应用。"), { statusCode: 400 });
    if (!providerId || !model) throw Object.assign(new Error("供应商和模型不能为空。"), { statusCode: 400 });
    if (!prompt.trim()) throw Object.assign(new Error("固定提示词不能为空。"), { statusCode: 400 });
    if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw Object.assign(new Error("max tokens 超出允许范围。"), { statusCode: 400 });

    pruneProviderRuns();
    let run = providerRuns.get(runId);
    if (run) {
      const changed = run.appType !== appType || run.providerId !== providerId || run.model !== model || run.prompt !== prompt || run.maxTokens !== maxTokens || run.stream !== stream;
      if (changed) throw Object.assign(new Error("同一次测速运行不能更换应用、供应商、模型或固定参数。"), { statusCode: 409 });
    } else {
      const catalog = await buildProviderCatalog();
      const provider = catalog.resolved.find((item) => item.public.appType === appType && item.public.id === providerId);
      if (!provider) throw Object.assign(new Error("未找到该 CC Switch 供应商，请刷新后重试。"), { statusCode: 404 });
      if (!provider.public.testable) throw Object.assign(new Error(provider.public.unavailableReason || "该供应商当前不可测速。"), { statusCode: 409 });
      if (!provider.public.models.some((item) => item.id === model)) throw Object.assign(new Error("该模型不属于所选供应商，请刷新后重试。"), { statusCode: 400 });
      run = {
        appType,
        providerId,
        model,
        prompt,
        maxTokens,
        stream,
        createdAt: Date.now(),
        target: { ...provider.internal, model }
      };
      providerRuns.set(runId, run);
    }

    target = run.target;
    const payload = buildProviderPayload(target, prompt, maxTokens, stream);
    const headers = {
      Accept: stream ? "text/event-stream" : "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...target.headers
    };
    // OpenCode Go rejects requests without a session id; keep one stable per benchmark run.
    if (/(^|\.)opencode\.ai$/i.test(safeHost(target.upstreamUrl))) {
      if (!run.sessionId) run.sessionId = `ses_${randomBytes(13).toString("hex")}`;
      headers["x-opencode-session"] = run.sessionId;
    }
    const upstream = await fetch(target.upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "follow"
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      const safe = redactSecrets(raw.slice(0, 65536), target.secrets);
      res.writeHead(upstream.status, {
        ...ccCorsHeaders,
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(safe),
        "Cache-Control": "no-store"
      });
      res.end(safe);
      return;
    }

    res.writeHead(upstream.status, responseHeadersForCc(upstream));
    if (!upstream.body) {
      res.end();
      return;
    }
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (error.name === "AbortError" || res.writableEnded) return;
    const status = error.statusCode || 502;
    const cause = error.cause?.code || error.cause?.message || "";
    const baseMessage = error.statusCode
      ? (error.message || "CC Switch 供应商请求失败。")
      : `本地代理连接上游失败：${error.message || "unknown"}${cause ? ` (${cause})` : ""}`;
    const message = target ? redactSecrets(baseMessage, target.secrets) : baseMessage;
    if (!res.headersSent) endJson(res, status, { error: { message } }, ccCorsHeaders);
    else res.end();
  }
}

async function proxyRequest(req, res, upstreamUrl, kind) {
  const controller = new AbortController();
  const close = () => controller.abort();
  req.once("aborted", close);
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const body = await readBody(req);
    const auth = req.headers.authorization || "";
    const isAnthropic = kind === "anthropic";
    const isCcSwitch = kind === "cc-switch";
    const session = isAnthropic || isCcSwitch ? null : sessionFrom(req);

    const headers = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT
    };
    if (auth && !isCcSwitch) headers.Authorization = auth;

    if (isCcSwitch) {
      // CC Switch's local router injects the active provider credentials.
      // Do not forward browser Authorization or API-key headers.
    } else if (isAnthropic) {
      if (req.headers["x-api-key"]) headers["x-api-key"] = req.headers["x-api-key"];
      headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
      if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = req.headers["anthropic-beta"];
      if (req.headers["anthropic-dangerous-direct-browser-access"]) {
        headers["anthropic-dangerous-direct-browser-access"] = req.headers["anthropic-dangerous-direct-browser-access"];
      }
    } else {
      headers["x-opencode-session"] = session;
    }

    const responseCors = isCcSwitch ? ccCorsHeaders : corsHeaders;
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });

    const contentType = upstream.headers.get("content-type") || "text/event-stream; charset=utf-8";
    const responseHeaders = {
      ...responseCors,
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    };
    if (session) responseHeaders["X-OpenCode-Session"] = session;
    if (upstream.headers.get("request-id")) responseHeaders["request-id"] = upstream.headers.get("request-id");
    if (upstream.headers.get("anthropic-ratelimit-requests-remaining")) {
      responseHeaders["anthropic-ratelimit-requests-remaining"] = upstream.headers.get("anthropic-ratelimit-requests-remaining");
    }
    if (upstream.headers.get("anthropic-ratelimit-tokens-remaining")) {
      responseHeaders["anthropic-ratelimit-tokens-remaining"] = upstream.headers.get("anthropic-ratelimit-tokens-remaining");
    }
    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    // Preserve streaming. Do not buffer the whole upstream response here.
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (error.name === "AbortError" || res.writableEnded) return;
    if (!res.headersSent) {
      endJson(res, 502, {
        error: {
          message: `Local API proxy request failed: ${error.message}`
        }
      }, kind === "cc-switch" ? ccCorsHeaders : corsHeaders);
    } else {
      res.end();
    }
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
  const isCcRoute = pathname.startsWith("/api/cc-switch/");

  if (isCcRoute && !ccOriginAllowed(req)) {
    endJson(res, 403, { error: { message: "CC Switch bridge is only available from the local TPS Bench page." } }, ccCorsHeaders);
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, isCcRoute ? ccCorsHeaders : corsHeaders);
    res.end();
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/tps-bench.html")) {
    await servePage(res);
    return;
  }

  if (req.method === "GET" && pathname === "/basecoat.css") {
    try {
      const css = await readFile(basecoatPath);
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Content-Length": css.length,
        "Cache-Control": "public, max-age=3600"
      });
      res.end(css);
    } catch (_) {
      endJson(res, 404, { error: { message: "Basecoat stylesheet not found" } });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/healthz") {
    endJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/favicon.ico") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === "GET" && (pathname === "/api/cc-switch/models" || pathname === "/api/cc-switch/profiles")) {
    await handleCcSwitchModels(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/cc-switch/providers") {
    await handleCcSwitchProviders(res);
    return;
  }

  const providerModelsMatch = pathname.match(/^\/api\/cc-switch\/providers\/([^/]+)\/([^/]+)\/models$/);
  if (req.method === "GET" && providerModelsMatch) {
    let appType = "";
    let providerId = "";
    try {
      appType = decodeURIComponent(providerModelsMatch[1]);
      providerId = decodeURIComponent(providerModelsMatch[2]);
    } catch (_) {
      endJson(res, 400, { error: { message: "供应商路径无效。" } }, ccCorsHeaders);
      return;
    }
    await handleCcSwitchProviders(res, appType, providerId);
    return;
  }

  if (req.method === "POST" && pathname === "/api/cc-switch/provider-request") {
    await handleProviderRequest(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/cc-switch/chat/completions") {
    await proxyRequest(req, res, `${CC_SWITCH_ORIGIN}/v1/chat/completions`, "cc-switch");
    return;
  }

  if (req.method === "POST" && pathname === "/api/cc-switch/messages") {
    await proxyRequest(req, res, `${CC_SWITCH_ORIGIN}/v1/messages`, "cc-switch");
    return;
  }

  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/api/v1/chat/completions")) {
    await proxyRequest(req, res, OPENCODE_UPSTREAM, "opencode");
    return;
  }

  if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/api/v1/messages")) {
    await proxyRequest(req, res, ANTHROPIC_UPSTREAM, "anthropic");
    return;
  }

  endJson(res, 404, { error: { message: "Not found" } });
});

server.on("error", (error) => {
  console.error(`Proxy server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`TPS Bench: http://${HOST}:${PORT}/`);
  console.log(`OpenCode upstream: ${OPENCODE_UPSTREAM}`);
  console.log(`Anthropic upstream: ${ANTHROPIC_UPSTREAM}`);
  console.log(`CC Switch DB (read-only): ${CC_SWITCH_DB}`);
  console.log("CC Switch credentials stay in the local proxy and are never logged.");
});
