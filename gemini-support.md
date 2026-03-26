# Analyse : Support de Gemini Web et Sessions pour ClaudeBox

## 1. Contexte

ClaudeBox est actuellement un wrapper autour du CLI Claude Code qui expose une API HTTP (endpoint natif `/prompt` et endpoints compatibles OpenAI `/v1/chat/completions`). Le projet utilise exclusivement le subprocess `claude` pour communiquer avec l'API Anthropic.

L'objectif est d'étendre ClaudeBox pour supporter **Google Gemini** comme provider alternatif, incluant :
- La gestion de **sessions de communication** (création, récupération, persistance)
- L'envoi de **messages dans une session**
- Le respect du **même standard de communication** utilisé par Claude Code dans le projet

---

## 2. Architecture Actuelle

### 2.1 Communication Claude (standard actuel)

```
Client HTTP → server.js → spawn("claude", args) → stdout JSON → Client HTTP
```

- **Entrée** : JSON via POST `/prompt` ou `/v1/chat/completions`
- **Traitement** : Subprocess Claude CLI avec flags (`-p`, `--output-format json`, etc.)
- **Sortie** : JSON structuré `{ result, session_id, usage, total_cost_usd }`
- **Sessions** : Désactivées (`--no-session-persistence`), multi-turn via sérialisation de l'historique dans le prompt

### 2.2 Format OpenAI Compatible (standard de réponse)

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1711100000,
  "model": "claude-sonnet-4-6",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

---

## 3. API Gemini : Points d'Intégration

### 3.1 Endpoint REST Gemini

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

**Payload :**
```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "Bonjour" }] },
    { "role": "model", "parts": [{ "text": "Bonjour ! Comment puis-je vous aider ?" }] },
    { "role": "user", "parts": [{ "text": "Explique-moi le DNS" }] }
  ],
  "systemInstruction": {
    "parts": [{ "text": "Tu es un assistant utile." }]
  },
  "generationConfig": {
    "temperature": 0.7,
    "maxOutputTokens": 8192,
    "responseMimeType": "application/json",
    "responseSchema": { ... }
  }
}
```

**Réponse :**
```json
{
  "candidates": [{
    "content": {
      "parts": [{ "text": "..." }],
      "role": "model"
    },
    "finishReason": "STOP"
  }],
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 50,
    "totalTokenCount": 150
  }
}
```

### 3.2 Authentification Gemini

- **API Key** : Paramètre `?key=API_KEY` ou header `x-goog-api-key`
- **Variable d'environnement** : `GEMINI_API_KEY`

### 3.3 Modèles Supportés

| Modèle | Description |
|--------|------------|
| `gemini-2.0-flash` | Rapide, économique |
| `gemini-2.0-pro` | Haute qualité |
| `gemini-1.5-flash` | Legacy rapide |
| `gemini-1.5-pro` | Legacy haute qualité |

---

## 4. Conception de la Solution

### 4.1 Couche d'Abstraction Provider

Créer une abstraction minimale qui permet de router les requêtes vers Claude ou Gemini selon le modèle demandé.

**Fichiers à créer/modifier :**

```
server.js                 ← Refactoring : routage par provider
providers/
  base.js                 ← Interface commune Provider
  claude.js               ← Provider Claude (refactoring de runClaude)
  gemini.js               ← Provider Gemini (nouveau, HTTP natif)
sessions/
  session-store.js        ← Gestionnaire de sessions en mémoire
```

### 4.2 Interface Provider

```javascript
// providers/base.js
class BaseProvider {
  async invoke(prompt, options) {
    // Retourne : { text, usage: { input_tokens, output_tokens } }
    throw new Error("Not implemented");
  }

  listModels() {
    // Retourne : [{ id, owned_by }]
    throw new Error("Not implemented");
  }
}
```

### 4.3 Provider Gemini

Le provider Gemini utilisera le module `https` natif de Node.js (pas de dépendances npm) pour maintenir la philosophie zero-dependency du projet.

**Fonctionnalités :**
- Appel REST `generateContent` via HTTPS
- Conversion des messages OpenAI → format Gemini `contents`
- Extraction de la réponse depuis `candidates[0].content.parts[0].text`
- Mapping `usageMetadata` → format unifié `{ input_tokens, output_tokens }`
- Support du `systemInstruction` pour les prompts système
- Support JSON schema via `generationConfig.responseSchema`

### 4.4 Gestion des Sessions

Les sessions permettent de maintenir un historique de conversation côté serveur, suivant le même pattern que ClaudeBox utilise actuellement (sérialisation de l'historique) mais avec persistance en mémoire.

#### Endpoints de Session

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| `POST` | `/sessions` | Créer une nouvelle session |
| `GET` | `/sessions/:id` | Récupérer une session existante |
| `POST` | `/sessions/:id/messages` | Envoyer un message dans une session |
| `DELETE` | `/sessions/:id` | Supprimer une session |
| `GET` | `/sessions` | Lister les sessions actives |

#### Format de Session

```json
{
  "id": "session-<uuid>",
  "provider": "gemini",
  "model": "gemini-2.0-flash",
  "created_at": "2026-03-26T20:00:00.000Z",
  "updated_at": "2026-03-26T20:05:00.000Z",
  "messages": [
    { "role": "user", "content": "Bonjour" },
    { "role": "assistant", "content": "Bonjour ! Comment puis-je aider ?" }
  ],
  "system_prompt": "Tu es un assistant utile.",
  "options": {}
}
```

#### Créer une Session

**Requête :**
```json
POST /sessions
{
  "provider": "gemini",
  "model": "gemini-2.0-flash",
  "system_prompt": "Tu es un assistant utile.",
  "options": {}
}
```

**Réponse :**
```json
{
  "id": "session-a1b2c3d4",
  "provider": "gemini",
  "model": "gemini-2.0-flash",
  "created_at": "2026-03-26T20:00:00.000Z",
  "messages": []
}
```

#### Envoyer un Message

**Requête :**
```json
POST /sessions/session-a1b2c3d4/messages
{
  "content": "Explique-moi le protocole DNS"
}
```

**Réponse (format standard unifié, même standard que Claude) :**
```json
{
  "id": "msg-<uuid>",
  "session_id": "session-a1b2c3d4",
  "role": "assistant",
  "content": "Le DNS (Domain Name System) est...",
  "model": "gemini-2.0-flash",
  "provider": "gemini",
  "usage": {
    "input_tokens": 150,
    "output_tokens": 300,
    "total_tokens": 450
  },
  "created_at": "2026-03-26T20:01:00.000Z"
}
```

### 4.5 Compatibilité avec le Standard Existant

Les sessions fonctionnent aussi avec le provider Claude. L'endpoint `/v1/chat/completions` détecte automatiquement le provider selon le préfixe du modèle :

| Préfixe modèle | Provider |
|----------------|----------|
| `claude-*`, `sonnet`, `opus`, `haiku` | Claude (CLI subprocess) |
| `gemini-*` | Gemini (HTTP REST) |

L'endpoint OpenAI-compatible `/v1/chat/completions` est mis à jour pour supporter les deux providers de manière transparente.

---

## 5. Changements Requis

### 5.1 Nouveaux Fichiers

| Fichier | Description |
|---------|-------------|
| `providers/base.js` | Classe abstraite BaseProvider |
| `providers/claude.js` | Provider Claude (refactoring de runClaude) |
| `providers/gemini.js` | Provider Gemini (HTTP REST client) |
| `sessions/session-store.js` | Store de sessions en mémoire avec TTL |

### 5.2 Fichiers Modifiés

| Fichier | Changements |
|---------|-------------|
| `server.js` | Import providers, routage par modèle, endpoints sessions, mise à jour modèles |
| `allowed-domains.txt` | Ajout `generativelanguage.googleapis.com` |
| `entrypoint.sh` | Support variable `GEMINI_API_KEY` |
| `docker-compose.yml` | Documentation variable `GEMINI_API_KEY` |
| `README.md` | Documentation des nouveaux endpoints et configuration |

### 5.3 Variables d'Environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| `GEMINI_API_KEY` | Clé API Google Gemini | — (requis pour Gemini) |
| `SESSION_TTL_MINUTES` | Durée de vie des sessions en minutes | `60` |
| `MAX_SESSIONS` | Nombre maximum de sessions actives | `100` |

---

## 6. Sécurité

- La clé API Gemini est transmise uniquement dans les headers HTTP vers l'API Google, jamais exposée aux clients
- Les sessions expirent automatiquement après `SESSION_TTL_MINUTES`
- Le nombre de sessions est limité par `MAX_SESSIONS`
- Le firewall (iptables) est étendu pour autoriser `generativelanguage.googleapis.com`
- L'authentification API ClaudeBox (`CLAUDEBOX_API_KEY`) protège aussi les endpoints Gemini

---

## 7. Plan d'Implémentation

### Phase 1 : Fondation
1. Créer `providers/base.js` — Interface commune
2. Créer `providers/claude.js` — Refactoring de `runClaude()`
3. Créer `providers/gemini.js` — Client HTTP Gemini
4. Créer `sessions/session-store.js` — Store de sessions

### Phase 2 : Intégration
5. Modifier `server.js` — Router par provider + endpoints sessions
6. Modifier `allowed-domains.txt` — Domaines Gemini
7. Modifier `entrypoint.sh` — Variable GEMINI_API_KEY

### Phase 3 : Validation
8. Tests manuels des endpoints
9. Mise à jour documentation README.md

---

## 8. Limitations Connues

- **Pas de streaming** : Ni Claude ni Gemini ne supportent le streaming dans ClaudeBox actuellement
- **Sessions en mémoire** : Les sessions sont perdues au redémarrage du conteneur (pas de persistance disque)
- **Pas d'outils Gemini** : Les outils Claude (Read, Edit, Bash) ne sont pas disponibles pour Gemini
- **Pas de Live API** : L'intégration utilise l'API REST standard, pas la Live API WebSocket de Gemini
