const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { ClaudeProvider } = require("./providers/claude");
const { GeminiProvider } = require("./providers/gemini");
const { SessionStore } = require("./sessions/session-store");

const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4", 10);
const OPENAI_COMPAT = process.env.OPENAI_COMPAT === "1";
const CLAUDEBOX_API_KEY = process.env.CLAUDEBOX_API_KEY || "";

let activeRequests = 0;

// ---------------------------------------------------------------------------
// Providers & Sessions
// ---------------------------------------------------------------------------

const claudeProvider = new ClaudeProvider();
const geminiProvider = new GeminiProvider();
const sessionStore = new SessionStore();

/**
 * Resolve which provider to use based on model name.
 * @param {string} [model]
 * @returns {ClaudeProvider|GeminiProvider}
 */
function resolveProvider(model) {
  if (GeminiProvider.matchesModel(model)) return geminiProvider;
  return claudeProvider;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJSON(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Provider runner
// ---------------------------------------------------------------------------

/**
 * Run a prompt through the appropriate provider.
 * @param {string} prompt
 * @param {object} options
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}, raw?: string}>}
 */
async function runPrompt(prompt, options = {}) {
  const provider = resolveProvider(options.model);
  log("info", `invoking ${provider.name} provider`, {
    model: options.model,
    prompt: prompt.slice(0, 100),
  });
  return provider.invoke(prompt, options);
}

/**
 * Backward-compatible wrapper that returns raw Claude output.
 * Used by the /prompt endpoint which returns raw Claude JSON.
 */
async function runClaude(prompt, options = {}) {
  const provider = resolveProvider(options.model);

  if (provider.name === "claude") {
    // Return raw stdout for backward compatibility
    const result = await provider.invoke(prompt, options);
    return result.raw || JSON.stringify({ result: result.text, usage: result.usage });
  }

  // For Gemini, format output like Claude JSON
  const result = await provider.invoke(prompt, options);
  return JSON.stringify({
    result: result.text,
    provider: provider.name,
    model: options.model,
    usage: result.usage,
  });
}

// ---------------------------------------------------------------------------
// OpenAI Compatibility Layer
// ---------------------------------------------------------------------------

const TMP_DIR = process.env.CLAUDEBOX_TMP_DIR || "/workspace/.tmp";

const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

function checkApiKey(req) {
  if (!CLAUDEBOX_API_KEY) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${CLAUDEBOX_API_KEY}`;
}

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

function cleanupTmpFiles(files) {
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch (err) {
      log("warn", "failed to cleanup temp file", { file: f, error: err.message });
    }
  }
}

function processContentParts(content) {
  const textParts = [];
  const tmpFiles = [];

  try {
    for (const part of content) {
      if (part.type === "text") {
        textParts.push(part.text);
      } else if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (!match) {
          throw new Error(
            "Only data: base64 image URIs are supported. External image URLs are not accepted."
          );
        }
        const mimeType = match[1];
        const base64Data = match[2];
        const ext = MIME_TO_EXT[mimeType] || mimeType.split("/")[1];
        const filename = `img-${crypto.randomUUID()}.${ext}`;
        const filepath = path.join(TMP_DIR, filename);

        ensureTmpDir();
        fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));
        tmpFiles.push(filepath);

        textParts.push(
          `[Attached image: ${filepath} — use the Read tool to view this file]`
        );
      }
    }
  } catch (err) {
    cleanupTmpFiles(tmpFiles);
    throw err;
  }

  return { text: textParts.join("\n"), tmpFiles };
}

function extractMessageText(content) {
  if (typeof content === "string") return { text: content, tmpFiles: [] };
  if (Array.isArray(content)) return processContentParts(content);
  return { text: "", tmpFiles: [] };
}

function parseOpenAIRequest(body) {
  const messages = body.messages || [];
  const systemParts = [];
  const conversationMessages = [];
  const allTmpFiles = [];

  try {
    for (const msg of messages) {
      if (msg.role === "system") {
        const { text } = extractMessageText(msg.content);
        if (text) systemParts.push(text);
      } else {
        const { text, tmpFiles } = extractMessageText(msg.content);
        allTmpFiles.push(...tmpFiles);
        conversationMessages.push({ role: msg.role, text });
      }
    }
  } catch (err) {
    cleanupTmpFiles(allTmpFiles);
    throw err;
  }

  let prompt;
  if (conversationMessages.length === 0) {
    prompt = "";
  } else if (conversationMessages.length === 1) {
    prompt = conversationMessages[0].text;
  } else {
    const history = conversationMessages.slice(0, -1);
    const last = conversationMessages[conversationMessages.length - 1];

    const historyLines = history.map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${m.text}`;
    });

    prompt = `[conversation history]\n${historyLines.join("\n")}\n[current request]\n${last.text}`;
  }

  return {
    prompt,
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    model: body.model || null,
    responseFormat: body.response_format || null,
    tmpFiles: allTmpFiles,
  };
}

function getJsonSchemaString(responseFormat) {
  if (!responseFormat) return null;

  let schema;
  if (responseFormat.type === "json_schema") {
    schema = responseFormat.json_schema?.schema || responseFormat.schema;
    if (!schema) return null;
  } else if (responseFormat.type === "json_object") {
    schema = { type: "object" };
  } else {
    return null;
  }

  return JSON.stringify(schema);
}

function parseClaudeOutput(raw) {
  try {
    const parsed = JSON.parse(raw);
    let text;
    if (parsed.structured_output !== undefined) {
      text = JSON.stringify(parsed.structured_output);
    } else {
      text = parsed.result || raw;
    }
    return { text, usage: parsed.usage || {} };
  } catch {
    return { text: raw, usage: {} };
  }
}

function toOpenAIResponse(resultText, model, usage) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "claude-sonnet-4-6",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: resultText },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

async function handleChatCompletions(req, res) {
  if (!checkApiKey(req)) {
    sendJSON(res, 401, {
      error: { message: "Invalid API key", type: "authentication_error" },
    });
    return;
  }

  if (activeRequests >= MAX_CONCURRENT) {
    log("warn", "rejected openai request, at capacity", { activeRequests });
    sendJSON(res, 429, {
      error: { message: "Too many concurrent requests", type: "rate_limit_error" },
    });
    return;
  }

  activeRequests++;
  let parsed;
  try {
    const rawBody = await readBody(req);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJSON(res, 400, {
        error: { message: "Invalid JSON body", type: "invalid_request_error" },
      });
      return;
    }

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      sendJSON(res, 400, {
        error: { message: "Missing or empty 'messages' array", type: "invalid_request_error" },
      });
      return;
    }

    try {
      parsed = parseOpenAIRequest(body);
    } catch (err) {
      sendJSON(res, 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
      return;
    }

    if (!parsed.prompt) {
      sendJSON(res, 400, {
        error: { message: "No user message content found", type: "invalid_request_error" },
      });
      return;
    }

    const options = {};
    if (parsed.systemPrompt) options.systemPrompt = parsed.systemPrompt;
    if (parsed.model) options.model = parsed.model;

    const jsonSchema = getJsonSchemaString(parsed.responseFormat);
    if (jsonSchema) options.jsonSchema = jsonSchema;

    const provider = resolveProvider(parsed.model);
    log("info", `openai compat: invoking ${provider.name}`, { model: parsed.model, hasSchema: !!jsonSchema });
    const result = await runPrompt(parsed.prompt, options);

    sendJSON(res, 200, toOpenAIResponse(result.text, parsed.model, result.usage));
  } catch (err) {
    log("error", "openai compat error", { error: err.message });
    sendJSON(res, 500, {
      error: { message: err.message, type: "server_error" },
    });
  } finally {
    if (parsed?.tmpFiles?.length > 0) {
      cleanupTmpFiles(parsed.tmpFiles);
    }
    activeRequests--;
  }
}

function handleModels(req, res) {
  if (!checkApiKey(req)) {
    sendJSON(res, 401, {
      error: { message: "Invalid API key", type: "authentication_error" },
    });
    return;
  }

  const allModels = [
    ...claudeProvider.listModels(),
    ...(geminiProvider.isConfigured() ? geminiProvider.listModels() : []),
  ].map((m) => ({
    id: m.id,
    object: "model",
    created: 1711100000,
    owned_by: m.owned_by,
  }));

  sendJSON(res, 200, { object: "list", data: allModels });
}

// ---------------------------------------------------------------------------
// Session API handlers
// ---------------------------------------------------------------------------

/**
 * Extract URL path parameters. Simple pattern matching for /sessions/:id/...
 * @param {string} url
 * @returns {{base: string, sessionId: string|null, action: string|null}}
 */
function parseSessionUrl(url) {
  const parts = url.split("?")[0].split("/").filter(Boolean);
  // /sessions
  if (parts.length === 1 && parts[0] === "sessions") {
    return { base: "sessions", sessionId: null, action: null };
  }
  // /sessions/:id
  if (parts.length === 2 && parts[0] === "sessions") {
    return { base: "sessions", sessionId: parts[1], action: null };
  }
  // /sessions/:id/messages
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "messages") {
    return { base: "sessions", sessionId: parts[1], action: "messages" };
  }
  return { base: null, sessionId: null, action: null };
}

async function handleCreateSession(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJSON(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const provider = body.provider || (GeminiProvider.matchesModel(body.model) ? "gemini" : "claude");

  // Check Gemini configuration if needed
  if (provider === "gemini" && !geminiProvider.isConfigured()) {
    sendJSON(res, 400, {
      error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
    });
    return;
  }

  const session = sessionStore.create({
    provider,
    model: body.model || null,
    system_prompt: body.system_prompt || null,
    options: body.options || {},
  });

  sendJSON(res, 201, session);
}

function handleGetSession(res, sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) {
    sendJSON(res, 404, { error: "Session not found or expired" });
    return;
  }
  sendJSON(res, 200, session);
}

function handleDeleteSession(res, sessionId) {
  const deleted = sessionStore.delete(sessionId);
  if (!deleted) {
    sendJSON(res, 404, { error: "Session not found" });
    return;
  }
  sendJSON(res, 200, { deleted: true });
}

function handleListSessions(res) {
  const sessions = sessionStore.list();
  sendJSON(res, 200, { sessions, count: sessions.length });
}

async function handleSendMessage(req, res, sessionId) {
  if (activeRequests >= MAX_CONCURRENT) {
    log("warn", "rejected session message, at capacity", { activeRequests });
    sendJSON(res, 429, { error: "Too many concurrent requests" });
    return;
  }

  const session = sessionStore.get(sessionId);
  if (!session) {
    sendJSON(res, 404, { error: "Session not found or expired" });
    return;
  }

  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJSON(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!body.content) {
    sendJSON(res, 400, { error: "Missing 'content' field" });
    return;
  }

  activeRequests++;
  try {
    // Record the user message
    sessionStore.addMessage(sessionId, "user", body.content);

    // Get conversation history for context
    const history = sessionStore.getHistory(sessionId);
    // Remove the last message (current prompt) from history for the provider
    const conversationHistory = history.slice(0, -1);

    const provider = resolveProvider(session.model);
    const options = {
      model: session.model,
      systemPrompt: session.system_prompt,
      conversationHistory,
      ...(session.options || {}),
    };

    const result = await provider.invoke(body.content, options);

    // Record the assistant response
    const message = sessionStore.addMessage(sessionId, "assistant", result.text, {
      model: session.model,
      provider: session.provider,
      usage: result.usage,
    });

    sendJSON(res, 200, {
      id: message.id,
      session_id: sessionId,
      role: "assistant",
      content: result.text,
      model: session.model,
      provider: session.provider,
      usage: {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        total_tokens: result.usage.input_tokens + result.usage.output_tokens,
      },
      created_at: message.created_at,
    });
  } catch (err) {
    log("error", "session message error", { sessionId, error: err.message });
    sendJSON(res, 500, { error: err.message });
  } finally {
    activeRequests--;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // --- Health check ---
  if (req.method === "GET" && req.url === "/health") {
    sendJSON(res, 200, { status: "ok", activeRequests });
    return;
  }

  // --- Session API ---
  const sessionRoute = parseSessionUrl(req.url);
  if (sessionRoute.base === "sessions") {
    // POST /sessions — create session
    if (req.method === "POST" && !sessionRoute.sessionId) {
      await handleCreateSession(req, res);
      return;
    }

    // GET /sessions — list sessions
    if (req.method === "GET" && !sessionRoute.sessionId) {
      handleListSessions(res);
      return;
    }

    // GET /sessions/:id — get session
    if (req.method === "GET" && sessionRoute.sessionId && !sessionRoute.action) {
      handleGetSession(res, sessionRoute.sessionId);
      return;
    }

    // DELETE /sessions/:id — delete session
    if (req.method === "DELETE" && sessionRoute.sessionId && !sessionRoute.action) {
      handleDeleteSession(res, sessionRoute.sessionId);
      return;
    }

    // POST /sessions/:id/messages — send message
    if (req.method === "POST" && sessionRoute.sessionId && sessionRoute.action === "messages") {
      await handleSendMessage(req, res, sessionRoute.sessionId);
      return;
    }
  }

  // --- Custom prompt API ---
  if (req.method === "POST" && req.url === "/prompt") {
    if (activeRequests >= MAX_CONCURRENT) {
      log("warn", "rejected request, at capacity", { activeRequests });
      sendJSON(res, 429, { error: "Too many concurrent requests" });
      return;
    }

    activeRequests++;
    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON body" });
        return;
      }

      if (!body.prompt) {
        sendJSON(res, 400, { error: "Missing 'prompt' field" });
        return;
      }

      const result = await runClaude(body.prompt, body.options || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(result);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    } finally {
      activeRequests--;
    }
    return;
  }

  // --- OpenAI-compatible endpoints ---
  if (OPENAI_COMPAT) {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      handleModels(req, res);
      return;
    }
  }

  // --- 404 ---
  const routes = [
    "POST /prompt",
    "GET /health",
    "POST /sessions",
    "GET /sessions",
    "GET /sessions/:id",
    "DELETE /sessions/:id",
    "POST /sessions/:id/messages",
  ];
  if (OPENAI_COMPAT) {
    routes.push("POST /v1/chat/completions", "GET /v1/models");
  }
  sendJSON(res, 404, { error: `Not found. Available: ${routes.join(", ")}` });
});

server.listen(PORT, "0.0.0.0", () => {
  log("info", `claudebox server listening on port ${PORT}`, {
    maxConcurrent: MAX_CONCURRENT,
    openaiCompat: OPENAI_COMPAT,
  });
});
