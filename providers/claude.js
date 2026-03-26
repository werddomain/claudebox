// ---------------------------------------------------------------------------
// Claude Provider — wraps the Claude CLI subprocess
// ---------------------------------------------------------------------------

const { spawn } = require("child_process");
const { BaseProvider } = require("./base");

class ClaudeProvider extends BaseProvider {
  get name() {
    return "claude";
  }

  listModels() {
    return [
      { id: "claude-sonnet-4-6", owned_by: "anthropic" },
      { id: "claude-opus-4-6", owned_by: "anthropic" },
      { id: "claude-haiku-4-5-20251001", owned_by: "anthropic" },
      { id: "sonnet", owned_by: "anthropic" },
      { id: "opus", owned_by: "anthropic" },
      { id: "haiku", owned_by: "anthropic" },
    ];
  }

  /**
   * Check if a model identifier belongs to this provider.
   * @param {string} model
   * @returns {boolean}
   */
  static matchesModel(model) {
    if (!model) return true; // default provider
    const m = model.toLowerCase();
    return (
      m.startsWith("claude-") ||
      m === "sonnet" ||
      m === "opus" ||
      m === "haiku"
    );
  }

  async invoke(prompt, options = {}) {
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
      if (options.jsonSchema) args.push("--json-schema", options.jsonSchema);
      if (options.allowedTools)
        args.push("--allowedTools", ...options.allowedTools);

      // Build the full prompt with conversation history if provided
      let fullPrompt = prompt;
      if (
        options.conversationHistory &&
        options.conversationHistory.length > 0
      ) {
        const historyLines = options.conversationHistory.map((m) => {
          const role = m.role === "assistant" ? "Assistant" : "User";
          return `${role}: ${m.content}`;
        });
        fullPrompt = `[conversation history]\n${historyLines.join("\n")}\n[current request]\n${prompt}`;
      }

      args.push(fullPrompt);

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
          reject(new Error(stderr || `claude exited with code ${code}`));
        } else {
          // Parse Claude JSON output
          try {
            const parsed = JSON.parse(stdout);
            let text;
            if (parsed.structured_output !== undefined) {
              text = JSON.stringify(parsed.structured_output);
            } else {
              text = parsed.result || stdout;
            }
            resolve({
              text,
              usage: {
                input_tokens: parsed.usage?.input_tokens || 0,
                output_tokens: parsed.usage?.output_tokens || 0,
              },
              raw: stdout,
            });
          } catch {
            resolve({ text: stdout, usage: { input_tokens: 0, output_tokens: 0 }, raw: stdout });
          }
        }
      });
    });
  }
}

module.exports = { ClaudeProvider };
