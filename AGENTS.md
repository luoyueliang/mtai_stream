# Agent Guidelines — mtai_stream

## Foundational Context

mtai_stream is a lightweight **SSE streaming middleware** between the Laravel backend and AI providers (apisvr/Dify). It is NOT a full application — it has no database, no auth logic, no business rules.

**Architecture position:**
```
front (UI) → backend (鉴权/积分/Task) → stream (SSE 流式代理) → dify | apisvr
```

### Package Versions

- node - 22
- typescript - 5.8
- fastify - 5
- ioredis - 5
- tsx (dev) - 4

### Module System

- **CommonJS** (`"module": "CommonJS"` in tsconfig)
- No `.js` extensions in imports
- No top-level `await`
- No `import.meta.url`

## Conventions

- All environment config goes through `src/config.ts` — never read `process.env` directly elsewhere.
- Files use kebab-case; variables/functions use camelCase; types/interfaces use PascalCase.
- Each upstream AI provider gets its own file under `src/upstream/` (e.g., `apisvr.ts`, `dify.ts`).
- Minimize dependencies — use Node.js built-in `fetch` and manual SSE line parsing. No axios, no eventsource libraries.

## Architecture Rules

1. **stream does NOT connect to MySQL.** All persistence goes through backend internal APIs.
2. **stream does NOT make auth decisions.** It validates Bearer tokens by calling backend `/api/v1/user`.
3. **stream does NOT create Tasks.** It receives task notifications via Redis pub/sub from backend.
4. **API keys are ephemeral** — fetched per-task from backend `stream-config` endpoint, never stored.

## Communication with Backend

| Direction | Mechanism | Auth |
|-----------|-----------|------|
| backend → stream | Redis publish `stream-tasks` | N/A (same-host Redis) |
| stream → backend (internal) | HTTP `X-Internal-Token` header | Shared secret |
| browser → stream (SSE) | HTTP `Authorization: Bearer` | Token validated via backend API |

## Testing

- Run `npm run typecheck` to verify TypeScript compiles cleanly.
- Run `npm run build` to produce `dist/` output.
- Integration tests require Redis and backend running — document test prerequisites clearly.

## Cross-Project Knowledge Base

Architecture decisions and backlog are maintained in `mtai_core/kb/`:
- `kb/architecture.md` — ADR-004 covers the streaming middleware design
- `kb/backlog.md` — BL-002 Phase 2-4 covers streaming implementation phases
- `kb/tech-stack.md` — Full tech stack across all projects

**Consult these before making architectural changes.**
