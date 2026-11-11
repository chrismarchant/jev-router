# Development

Zero dependencies; Node ≥ 18.

```bash
node --test test/*.test.js   # 36 tests: client (retries/timeouts/headers), question builders,
                             # all 9 tool handlers, MCP handshake, CLI end-to-end — against mock
                             # TypeSafe + Mistral HTTP servers, so no API keys are needed
bash scripts/verify.sh       # syntax check + MCP stdio handshake + tools/list (9 tools) +
                             # missing-key error + CLI help; with TYPESAFE_API_KEY set it also
                             # makes a live jev_models call
```

## Layout of the tests

- `test/helpers.js` — `startMock` (in-process HTTP mock), `mockTypeSafe` (canned `/v1/systemone`, `/v1/models`, with 429/422/delay modes), `fakeClient`.
- `test/client.test.js` — request shape, auth header, model override, retry-on-429, no-retry-on-422, images header, missing-key error, timeout, validation.
- `test/tools.test.js` — the 9 handlers: route bands/floors, plan single-request fan-out + composite, review three-band, batch pool bound + per-item failure, fan-out discard lists, box assets + companion noul, draft-options via mock Mistral.
- `test/mcp.test.js` — spawns `mcp-server/server.js`, speaks newline JSON-RPC: initialize/tools/list/tools/call, missing-key isError.
- `test/cli.test.js` — spawns `bin/jev-router.js`: help, exit codes, models/ask/plan/box/draft-options against mocks, `@file` inputs.

## Committing / releasing

Work happens on GitHub (no local clones of this repo). To change files, commit via the git-data API (blobs → tree → commit → update `refs/heads/main`) or any git client, e.g.:

```bash
gh api -X POST repos/chrismarchant/jev-router/git/blobs --input -   # per changed file
# … assemble tree, commit, PATCH refs/heads/main
```

Bump `version` in `package.json` + `plugin.json` + `.claude-plugin/plugin.json` together, and tag releases (`git tag vX.Y.Z` via `gh api .../git/refs`).

## Adding a tool

1. Add the handler in `mcp-server/tools.js` and register it in `TOOLS` + `HANDLERS`.
2. Add the CLI case in `bin/jev-router.js` (+ USAGE).
3. Add tests in `test/tools.test.js` (and `test/cli.test.js`/`test/mcp.test.js` if user-facing); update `scripts/verify.sh` tool count.
4. Document it in `docs/tools.md`, `docs/cli.md`, `README.md`, and `skills/jev-router/SKILL.md`.
