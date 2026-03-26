# claudebox

Claude in a box

<img width="2781" height="1331" alt="Gemini_Generated_Image_3bck2g3bck2g3bck" src="https://github.com/user-attachments/assets/86776f7e-f717-4d5d-92b9-87bfc57a3dad" />

## Why?

- **Use it however you want**: Run Claude from your terminal as a CLI, or drop it into an existing Docker Compose stack as a service.
- **No API key, no extra billing**: claudebox uses your existing Claude subscription and authenticates with your current Claude credentials, so personal use feels seamless.
- **Real agent, strong isolation**: Claude gets its full toolset inside the container—file editing, shell access, code analysis, and more; without access to your host machine or the open internet beyond Anthropic’s APIs.

## Prerequisites

- **Docker** — [Install Docker Desktop](https://docs.docker.com/get-docker/)
- **Claude CLI** — installed and authenticated (`curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` once to log in)

claudebox uses your Claude subscription. It reads local credentials (Keychain on macOS, `~/.claude/.credentials.json` on Linux) to authenticate inside the container. Credentials are resolved in order: `CLAUDE_CODE_OAUTH_TOKEN` env var, then platform credential store.

## Use as a CLI tool

**For:** running prompts and agentic tasks in a sandboxed container from your terminal.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/ArmanJR/claudebox/main/install.sh | bash
```

### Usage

```bash
claudebox prompt "explain how DNS works"    # run a single prompt
claudebox prompt --json "explain DNS"       # full JSON output
claudebox prompt --verbose "explain DNS"    # container logs + output
claudebox server                            # start the HTTP API server
claudebox server --openai                   # start with OpenAI-compatible API
claudebox stop                              # stop the server
claudebox logs                              # view server logs
claudebox status                            # check if server is running
claudebox version                           # show CLI version
claudebox update                            # update the CLI
```

Works on macOS and Linux. Handles authentication automatically and refreshes expired tokens before launching the container.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDEBOX_PORT` | `3000` | Host port |
| `CLAUDEBOX_IMAGE` | `ghcr.io/armanjr/claudebox:latest` | Docker image |
| `CLAUDEBOX_NAME` | `claudebox` | Container name |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Skip auto-detection, use this token directly |
| `CLAUDEBOX_API_KEY` | — | API key for `/v1/*` endpoints (used with `--openai`) |

## Use as a service

**For:** adding Claude as an agent alongside other services in your Docker Compose stack.

### Add to your docker-compose.yml

First, extract your OAuth token (re-run when it expires):

```bash
curl -fsSL https://raw.githubusercontent.com/ArmanJR/claudebox/main/setup-auth.sh | bash
```

```yaml
services:
  claudebox:
    image: ghcr.io/armanjr/claudebox:latest
    cap_add:
      - NET_ADMIN
    ports:
      - "3000:3000"
    env_file:
      - path: .env.claude
        required: true
```

Then `docker compose up -d`. Other services in the same network reach Claude at `http://claudebox:3000`.

### HTTP API

#### `POST /prompt`

Send a prompt to Claude and get a JSON response.

```json
{
  "prompt": "your prompt here",
  "options": {
    "model": "sonnet",
    "maxTurns": 10,
    "maxBudgetUsd": 1.0,
    "systemPrompt": "you are a helpful assistant",
    "appendSystemPrompt": "additional instructions",
    "allowedTools": ["Read", "Edit", "Bash"],
    "cwd": "/workspace"
  }
}
```

All fields in `options` are optional.

**Response:** Claude Code's JSON output (includes `result`, `session_id`, `usage`, `total_cost_usd`, etc.)

#### `GET /health`

Returns `{"status": "ok", "activeRequests": 0}`.

#### Server environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `MAX_CONCURRENT` | `4` | Max parallel Claude/Gemini processes |
| `OPENAI_COMPAT` | — | Set to `1` to enable `/v1/*` routes (set automatically by `--openai`) |
| `CLAUDEBOX_API_KEY` | — | If set, all `/v1/*` requests require `Authorization: Bearer <key>` |
| `GEMINI_API_KEY` | — | Google Gemini API key (enables Gemini models) |
| `SESSION_TTL_MINUTES` | `60` | Session expiration time in minutes |
| `MAX_SESSIONS` | `100` | Maximum number of active sessions |

### OpenAI-compatible API

Start the server with `--openai` (CLI) or set `OPENAI_COMPAT=1` (Docker) to expose `/v1/chat/completions` and `/v1/models`. This lets you use claudebox with any OpenAI-compatible client.

```bash
# CLI
claudebox server --openai

# Docker Compose — add to environment
OPENAI_COMPAT=1
```

#### `POST /v1/chat/completions`

Accepts the standard OpenAI chat completions request format and translates it to Claude Code invocations.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant"},
      {"role": "user", "content": "Explain DNS in one sentence"}
    ]
  }'
```

Returns a standard OpenAI-shaped response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "sonnet",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "..."},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
}
```

**Supported features:**

| Feature | How it maps |
|---|---|
| `messages[role=system]` | Concatenated into `--system-prompt` |
| Multi-turn conversation | Serialized into structured prompt with history |
| `model` | Passed through to Claude (`sonnet`, `opus`, `haiku`, or full model IDs) |
| `response_format` (`json_schema` / `json_object`) | Injected into prompt + validated; retries once on failure |
| Base64 images (`data:image/...;base64,...`) | Decoded to temp files, read by Claude's Read tool |

**Not supported:** streaming, function calling / tools, external image URLs, `temperature` / `top_p`, `n > 1`.

#### `GET /v1/models`

Lists available models (Claude models always, Gemini models when `GEMINI_API_KEY` is configured).

#### Authentication

If `CLAUDEBOX_API_KEY` is set, all `/v1/*` requests must include `Authorization: Bearer <key>`. The existing `/prompt` and `/health` endpoints are unaffected.

### Gemini Support

claudebox supports Google Gemini as an alternative provider. Set `GEMINI_API_KEY` to enable Gemini models. The provider is automatically selected based on the model name prefix:

| Model prefix | Provider |
|---|---|
| `claude-*`, `sonnet`, `opus`, `haiku` | Claude (CLI subprocess) |
| `gemini-*` | Gemini (REST API) |

Gemini models work with all existing endpoints (`/prompt`, `/v1/chat/completions`) and the new Session API.

**Available Gemini models:** `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-flash`, `gemini-1.5-pro`

### Session API

The Session API provides stateful multi-turn conversations with automatic history management. Sessions work with both Claude and Gemini providers.

#### `POST /sessions` — Create a new session

```bash
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gemini",
    "model": "gemini-2.0-flash",
    "system_prompt": "You are a helpful assistant"
  }'
```

#### `GET /sessions` — List active sessions

```bash
curl http://localhost:3000/sessions
```

#### `GET /sessions/:id` — Get session details

```bash
curl http://localhost:3000/sessions/session-abc123
```

#### `POST /sessions/:id/messages` — Send a message

```bash
curl -X POST http://localhost:3000/sessions/session-abc123/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "Explain how DNS works"}'
```

Returns:

```json
{
  "id": "msg-...",
  "session_id": "session-abc123",
  "role": "assistant",
  "content": "DNS (Domain Name System) is...",
  "model": "gemini-2.0-flash",
  "provider": "gemini",
  "usage": {"input_tokens": 100, "output_tokens": 200, "total_tokens": 300},
  "created_at": "2026-03-26T20:00:00.000Z"
}
```

#### `DELETE /sessions/:id` — Delete a session

```bash
curl -X DELETE http://localhost:3000/sessions/session-abc123
```

Sessions expire automatically after `SESSION_TTL_MINUTES` (default: 60 minutes) and are limited to `MAX_SESSIONS` (default: 100).

## How It Works

**Network isolation** — iptables firewall blocks all outbound traffic except Anthropic API domains and Google Gemini API (baked into the image). To allow additional domains, mount a custom allowlist:

```bash
-v /path/to/allowed-domains.txt:/etc/allowed-domains.txt:ro
```

**Workspace** — `/workspace` is writable so Claude can create and edit files. Mount context files read-only at `/workspace/context` for reference (put your `CLAUDE.md` there).

## Limitations

**IP-based firewall** — Domain allowlisting resolves IPs at container start. If Anthropic's CDN/load-balancer IPs rotate during the container's lifetime, connections will fail. Restart the container to re-resolve. This is an inherent limitation of iptables-based filtering.

## Building Locally

```bash
docker compose up -d --build
```

To pin a specific Claude Code version:

```bash
docker compose build --build-arg CLAUDE_CODE_VERSION=2.1.80
```

## License

MIT
