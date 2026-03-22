const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4", 10);
const OPENAI_COMPAT = process.env.OPENAI_COMPAT === "1";
const CLAUDEBOX_API_KEY = process.env.CLAUDEBOX_API_KEY || "";

let Ajv;
if (OPENAI_COMPAT) {
  Ajv = require("ajv");
}

let activeRequests = 0;

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
// Claude runner
// ---------------------------------------------------------------------------

function runClaude(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
    ];

    if (options.model) args.push("--model", options.model);
    if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
    if (options.maxBudgetUsd)
      args.push("--max-budget-usd", String(options.maxBudgetUsd));
    if (options.systemPrompt)
      args.push("--system-prompt", options.systemPrompt);
    if (options.appendSystemPrompt)
      args.push("--append-system-prompt", options.appendSystemPrompt);
    if (options.allowedTools)
      args.push("--allowedTools", ...options.allowedTools);

    args.push(prompt);

    log("info", "spawning claude", { prompt: prompt.slice(0, 100) });

    const proc = spawn("claude", args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: options.cwd || "/workspace",
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        log("error", "claude exited with error", { code, stderr });
        reject(new Error(stderr || `claude exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
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

function buildStructuredOutputInstructions(responseFormat) {
  if (!responseFormat) return null;

  if (responseFormat.type === "json_schema") {
    const schema =
      responseFormat.json_schema?.schema || responseFormat.schema;
    if (!schema) return null;
    return [
      "CRITICAL INSTRUCTION: Your final response must be ONLY a valid JSON object",
      "conforming exactly to the following schema. No markdown fences, no explanation,",
      "no surrounding text. Output raw JSON only.",
      "",
      "JSON Schema:",
      JSON.stringify(schema, null, 2),
    ].join("\n");
  }

  if (responseFormat.type === "json_object") {
    return [
      "CRITICAL INSTRUCTION: Your final response must be ONLY a valid JSON object.",
      "No markdown fences, no explanation, no surrounding text. Output raw JSON only.",
    ].join("\n");
  }

  return null;
}

function extractJsonFromResponse(text) {
  const trimmed = text.trim();

  // Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Find first JSON object or array
  const jsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // fall through
    }
  }

  return null;
}

function validateAgainstSchema(data, schema) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const errors = validate.errors
      .map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    return { valid: false, error: errors };
  }
  return { valid: true };
}

function getJsonSchema(responseFormat) {
  if (responseFormat?.type !== "json_schema") return null;
  return responseFormat.json_schema?.schema || responseFormat.schema || null;
}

function parseClaudeOutput(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      text: parsed.result || raw,
      usage: parsed.usage || {},
    };
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

async function attemptRepair(originalPrompt, options, previousOutput, validationError, responseFormat) {
  const repairPrompt = [
    "Your previous response did not conform to the required JSON schema.",
    "",
    "Original request:",
    originalPrompt,
    "",
    "Your output was:",
    previousOutput,
    "",
    "Validation error:",
    validationError,
    "",
    "Respond ONLY with a corrected valid JSON object matching the schema. No explanation.",
  ].join("\n");

  log("info", "openai compat: attempt 2 (repair)");

  try {
    const raw = await runClaude(repairPrompt, options);
    const { text } = parseClaudeOutput(raw);
    const jsonData = extractJsonFromResponse(text);

    if (jsonData === null) {
      return { error: "Failed to produce valid structured output after 2 attempts" };
    }

    const schema = getJsonSchema(responseFormat);
    if (schema) {
      const validation = validateAgainstSchema(jsonData, schema);
      if (!validation.valid) {
        return {
          error: `Failed to produce valid structured output after 2 attempts: ${validation.error}`,
        };
      }
    }

    return { text: JSON.stringify(jsonData) };
  } catch (err) {
    return { error: `Repair attempt failed: ${err.message}` };
  }
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

    const structuredInstructions = buildStructuredOutputInstructions(parsed.responseFormat);
    if (structuredInstructions) {
      options.appendSystemPrompt = structuredInstructions;
    }

    const needsJsonValidation =
      parsed.responseFormat &&
      (parsed.responseFormat.type === "json_schema" ||
        parsed.responseFormat.type === "json_object");
    const jsonSchema = getJsonSchema(parsed.responseFormat);

    // --- Attempt 1 ---
    log("info", "openai compat: attempt 1", { model: parsed.model });
    const raw = await runClaude(parsed.prompt, options);
    const { text: resultText, usage } = parseClaudeOutput(raw);
    let finalText = resultText;

    if (needsJsonValidation) {
      const jsonData = extractJsonFromResponse(resultText);

      if (jsonData === null) {
        log("warn", "openai compat: attempt 1 failed JSON parse, retrying");
        const repair = await attemptRepair(
          parsed.prompt, options, resultText, "Response is not valid JSON", parsed.responseFormat
        );
        if (repair.error) {
          sendJSON(res, 422, {
            error: { message: repair.error, type: "invalid_request_error" },
          });
          return;
        }
        finalText = repair.text;
      } else if (jsonSchema) {
        const validation = validateAgainstSchema(jsonData, jsonSchema);
        if (!validation.valid) {
          log("warn", "openai compat: attempt 1 failed schema validation", {
            error: validation.error,
          });
          const repair = await attemptRepair(
            parsed.prompt, options, resultText, validation.error, parsed.responseFormat
          );
          if (repair.error) {
            sendJSON(res, 422, {
              error: { message: repair.error, type: "invalid_request_error" },
            });
            return;
          }
          finalText = repair.text;
        } else {
          finalText = JSON.stringify(jsonData);
        }
      } else {
        // json_object — valid JSON is sufficient
        finalText = JSON.stringify(jsonData);
      }
    }

    sendJSON(res, 200, toOpenAIResponse(finalText, parsed.model, usage));
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

  const models = [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
    "sonnet",
    "opus",
    "haiku",
  ].map((id) => ({
    id,
    object: "model",
    created: 1711100000,
    owned_by: "anthropic",
  }));

  sendJSON(res, 200, { object: "list", data: models });
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
  const routes = ["POST /prompt", "GET /health"];
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
