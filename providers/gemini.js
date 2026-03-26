// ---------------------------------------------------------------------------
// Gemini Provider — HTTP REST client for Google Gemini API
// ---------------------------------------------------------------------------

const https = require("https");
const { BaseProvider } = require("./base");

const GEMINI_API_BASE = "generativelanguage.googleapis.com";
const GEMINI_API_VERSION = "v1beta";

class GeminiProvider extends BaseProvider {
  constructor() {
    super();
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  get name() {
    return "gemini";
  }

  listModels() {
    return [
      { id: "gemini-2.0-flash", owned_by: "google" },
      { id: "gemini-2.0-pro", owned_by: "google" },
      { id: "gemini-1.5-flash", owned_by: "google" },
      { id: "gemini-1.5-pro", owned_by: "google" },
    ];
  }

  /**
   * Check if a model identifier belongs to this provider.
   * @param {string} model
   * @returns {boolean}
   */
  static matchesModel(model) {
    if (!model) return false;
    return model.toLowerCase().startsWith("gemini-");
  }

  /**
   * Check if the provider is configured (API key available).
   * @returns {boolean}
   */
  isConfigured() {
    return !!this.apiKey;
  }

  /**
   * Build the Gemini API contents array from conversation history and current prompt.
   * @param {string} prompt - Current user message
   * @param {object[]} [conversationHistory] - Previous messages [{role, content}]
   * @returns {object[]}
   */
  _buildContents(prompt, conversationHistory) {
    const contents = [];

    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }

    contents.push({
      role: "user",
      parts: [{ text: prompt }],
    });

    return contents;
  }

  /**
   * Build generation config from options.
   * @param {object} options
   * @returns {object|null}
   */
  _buildGenerationConfig(options) {
    const config = {};
    let hasConfig = false;

    if (options.maxOutputTokens) {
      config.maxOutputTokens = options.maxOutputTokens;
      hasConfig = true;
    }

    if (options.jsonSchema) {
      try {
        config.responseMimeType = "application/json";
        config.responseSchema = JSON.parse(options.jsonSchema);
        hasConfig = true;
      } catch {
        // Ignore invalid JSON schema
      }
    }

    return hasConfig ? config : null;
  }

  /**
   * Make an HTTPS request to the Gemini API.
   * @param {string} model - Gemini model name
   * @param {object} body - Request body
   * @returns {Promise<object>}
   */
  _request(model, body) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);
      const apiPath = `/${GEMINI_API_VERSION}/models/${model}:generateContent`;

      const reqOptions = {
        hostname: GEMINI_API_BASE,
        port: 443,
        path: apiPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "x-goog-api-key": this.apiKey,
        },
      };

      const req = https.request(reqOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              const errMsg =
                parsed.error?.message || `Gemini API error (${res.statusCode})`;
              reject(new Error(errMsg));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(
              new Error(
                `Failed to parse Gemini response (${res.statusCode}): ${data.slice(0, 200)}`
              )
            );
          }
        });
      });

      req.on("error", (err) => reject(err));
      req.write(postData);
      req.end();
    });
  }

  /**
   * Extract text and usage from Gemini API response.
   * @param {object} response
   * @returns {{text: string, usage: {input_tokens: number, output_tokens: number}}}
   */
  _parseResponse(response) {
    const candidate = response.candidates?.[0];
    let text = "";

    if (candidate?.content?.parts) {
      text = candidate.content.parts
        .map((p) => p.text || "")
        .join("")
        .trim();
    }

    const usage = {
      input_tokens: response.usageMetadata?.promptTokenCount || 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount || 0,
    };

    return { text, usage };
  }

  async invoke(prompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error(
        "Gemini API key not configured. Set GEMINI_API_KEY environment variable."
      );
    }

    const model = options.model || "gemini-2.0-flash";
    const contents = this._buildContents(
      prompt,
      options.conversationHistory
    );

    const body = { contents };

    // Add system instruction if provided
    if (options.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: options.systemPrompt }],
      };
    }

    // Add generation config if needed
    const generationConfig = this._buildGenerationConfig(options);
    if (generationConfig) {
      body.generationConfig = generationConfig;
    }

    const response = await this._request(model, body);
    return this._parseResponse(response);
  }
}

module.exports = { GeminiProvider };
