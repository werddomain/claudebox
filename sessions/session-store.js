// ---------------------------------------------------------------------------
// Session Store — in-memory session management with TTL
// ---------------------------------------------------------------------------

const crypto = require("crypto");

const DEFAULT_TTL_MINUTES = parseInt(process.env.SESSION_TTL_MINUTES || "60", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "100", 10);

class SessionStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._sessions = new Map();

    // Cleanup expired sessions every 5 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    // Allow the timer to not prevent process exit
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  /**
   * Create a new session.
   * @param {object} params
   * @param {string} params.provider - Provider name ("claude" or "gemini")
   * @param {string} params.model - Model identifier
   * @param {string} [params.system_prompt] - System instructions
   * @param {object} [params.options] - Additional options
   * @returns {object} The created session
   */
  create({ provider, model, system_prompt, options }) {
    if (this._sessions.size >= MAX_SESSIONS) {
      // Remove oldest session to make room
      this._evictOldest();
    }

    const id = `session-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const session = {
      id,
      provider: provider || "claude",
      model: model || null,
      system_prompt: system_prompt || null,
      options: options || {},
      messages: [],
      created_at: now,
      updated_at: now,
      expires_at: new Date(
        Date.now() + DEFAULT_TTL_MINUTES * 60 * 1000
      ).toISOString(),
    };

    this._sessions.set(id, session);
    return this._toPublic(session);
  }

  /**
   * Get a session by ID.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    const session = this._sessions.get(id);
    if (!session) return null;

    // Check expiration
    if (new Date(session.expires_at) < new Date()) {
      this._sessions.delete(id);
      return null;
    }

    return this._toPublic(session);
  }

  /**
   * Get the internal session (including mutable messages array).
   * @param {string} id
   * @returns {object|null}
   */
  _getInternal(id) {
    const session = this._sessions.get(id);
    if (!session) return null;

    if (new Date(session.expires_at) < new Date()) {
      this._sessions.delete(id);
      return null;
    }

    return session;
  }

  /**
   * Add a message to a session and refresh its TTL.
   * @param {string} sessionId
   * @param {string} role - "user" or "assistant"
   * @param {string} content - Message content
   * @param {object} [meta] - Additional metadata (usage, model, etc.)
   * @returns {object} The message object
   */
  addMessage(sessionId, role, content, meta = {}) {
    const session = this._getInternal(sessionId);
    if (!session) return null;

    const message = {
      id: `msg-${crypto.randomUUID()}`,
      role,
      content,
      created_at: new Date().toISOString(),
      ...meta,
    };

    session.messages.push(message);
    session.updated_at = message.created_at;

    // Refresh TTL
    session.expires_at = new Date(
      Date.now() + DEFAULT_TTL_MINUTES * 60 * 1000
    ).toISOString();

    return message;
  }

  /**
   * Get conversation history for a session (for provider context).
   * @param {string} sessionId
   * @returns {{role: string, content: string}[]}
   */
  getHistory(sessionId) {
    const session = this._getInternal(sessionId);
    if (!session) return [];
    return session.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Delete a session.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    return this._sessions.delete(id);
  }

  /**
   * List all active (non-expired) sessions.
   * @returns {object[]}
   */
  list() {
    const now = new Date();
    const result = [];

    for (const [id, session] of this._sessions) {
      if (new Date(session.expires_at) < now) {
        this._sessions.delete(id);
      } else {
        result.push(this._toPublic(session));
      }
    }

    return result;
  }

  /**
   * Remove expired sessions.
   */
  _cleanup() {
    const now = new Date();
    for (const [id, session] of this._sessions) {
      if (new Date(session.expires_at) < now) {
        this._sessions.delete(id);
      }
    }
  }

  /**
   * Remove the oldest session.
   */
  _evictOldest() {
    let oldestId = null;
    let oldestTime = Infinity;

    for (const [id, session] of this._sessions) {
      const t = new Date(session.created_at).getTime();
      if (t < oldestTime) {
        oldestTime = t;
        oldestId = id;
      }
    }

    if (oldestId) this._sessions.delete(oldestId);
  }

  /**
   * Convert internal session to public format (safe for API response).
   * @param {object} session
   * @returns {object}
   */
  _toPublic(session) {
    return {
      id: session.id,
      provider: session.provider,
      model: session.model,
      system_prompt: session.system_prompt,
      messages: session.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
      })),
      created_at: session.created_at,
      updated_at: session.updated_at,
      expires_at: session.expires_at,
      message_count: session.messages.length,
    };
  }
}

module.exports = { SessionStore };
