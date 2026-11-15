APEX INTELLIGENCE — MULTI-API AI BACKEND (v3: real accounts)

NEW IN v3: real server-side sign-up / login, per-user daily limits, admin user list,
Supabase storage for free hosting. To put it online read DEPLOY_GUIDE_URDU.txt.
On your own computer the FIRST account you create becomes the admin.

WHAT IT DOES
- Serves the APEX app and connects it to MANY AI APIs at once:
  OpenAI, Anthropic Claude, Google Gemini, Groq, OpenRouter, and any OpenAI-compatible
  API (Ollama, LM Studio, DeepSeek, Mistral, Together, vLLM ...).
- API keys stay in .env on the server. They are never sent to the browser.
- No npm packages needed (zero dependencies). Requires Node.js 18 or newer.

SETUP (Windows) - EASY WAY
0. Double-click SETUP_KEY.bat, paste your keys, then double-click START_APEX.bat. (Skips steps 2-4 below.)

SETUP (Windows) - MANUAL WAY
1. Install Node.js LTS from https://nodejs.org/
2. Copy .env.example to .env (just ".env").
3. Open .env in Notepad and fill ONLY the keys you have. Providers with a real key turn on automatically.
4. In the project folder: click the address bar, type cmd, Enter, then run:
      npm start
5. Open http://localhost:3000 in Chrome and sign in.

HOW IT WORKS IN THE APP
- AI Workspace: choose "Auto" or a specific provider and model. The chat remembers the last 12 turns.
  "New chat" clears memory. Each answer shows which provider/model answered and how long it took.
- Auto mode: tries DEFAULT_PROVIDER first; if it fails (quota, outage) it falls back to the next
  configured provider in PROVIDER_ORDER and tells you.
- Admin Dashboard > API tab: shows every provider (configured or not), usage (requests, errors,
  average latency, tokens), a Test button per provider, and "Test all configured".
- The dashboard checks the backend automatically when the app opens (LIVE / OFFLINE).

SECURITY
- IMPORTANT: if a key was ever pasted in a chat or email, revoke it and create a new one.
- Only index.html is public. server.js and .env can NOT be downloaded (the old server exposed them).
- /api/stats, provider tests and user management are admin-only (session based).
- Chat is limited to RATE_LIMIT_PER_MINUTE requests per IP (default 20).
- Still a starter: keep it private (or add real user login) before putting it on the internet.

COSTS
- Each provider bills your own account separately. A chat subscription is not an API key.

ENDPOINTS
GET /api/health · GET /api/providers · POST /api/chat · POST /api/providers/:id/test · GET /api/stats
