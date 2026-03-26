// ---------------------------------------------------------------------------
// Base Provider — abstract interface for all LLM providers
// ---------------------------------------------------------------------------

class BaseProvider {
  /**
   * Invoke the provider with a prompt and options.
   * @param {string} prompt - The user prompt text
   * @param {object} options - Provider-specific options
   * @param {string} [options.model] - Model identifier
   * @param {string} [options.systemPrompt] - System instructions
   * @param {string} [options.jsonSchema] - JSON schema for structured output
   * @param {object[]} [options.conversationHistory] - Previous messages [{role, content}]
   * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
   */
  async invoke(prompt, options = {}) {
    throw new Error("invoke() not implemented");
  }

  /**
   * Return the list of models supported by this provider.
   * @returns {{id: string, owned_by: string}[]}
   */
  listModels() {
    throw new Error("listModels() not implemented");
  }

  /**
   * Return the provider name.
   * @returns {string}
   */
  get name() {
    throw new Error("name getter not implemented");
  }
}

module.exports = { BaseProvider };
