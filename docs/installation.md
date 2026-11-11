# Installation

One repo, four surfaces — pick what your harness supports. Everything is zero-dependency Node ≥ 18; no `npm install` is required when running from a checkout.

## 1. Mistral Vibe

**As a native plugin** (skills + MCP server), user scope:

```bash
mkdir -p ~/.vibe/plugins && cp -r jev-router ~/.vibe/plugins/jev-router
# in Vibe: /reload-plugins   (or project scope: <project>/.vibe/plugins/jev-router, requires a trusted folder)
```

The plugin ships `plugin.json` (Agent Plugins 1.0), `mcp.json` (stdio server at `${PLUGIN_ROOT}/mcp-server/server.js`), and `skills/jev-router/SKILL.md`.

**Or just the MCP server:**

```bash
vibe mcp add jev-router --transport stdio --command node --arg /abs/path/to/jev-router/mcp-server/server.js
```

**Key:** add `TYPESAFE_API_KEY=...` to `~/.vibe/.env` yourself (Vibe loads `.env` into every MCP server's environment), then `/reload`. Option-drafting additionally needs `MISTRAL_API_KEY` there too.

## 2. Claude Code

**As a plugin from this repo's marketplace:**

```bash
claude plugin marketplace add chrismarchant/jev-router
claude plugin install jev-router@chrismarchant
```

**Or project-local:** drop the repo's `.mcp.json` into your project (adjust the path) and set the key:

```bash
zsh scripts/set-typesafe-key.sh    # safely writes .claude/settings.local.json (gitignored)
```

The plugin also provides the `/parallel-jev` slash command ([commands/parallel-jev.md](../commands/parallel-jev.md)) and the `workstream-planner` subagent ([agents/workstream-planner.md](../agents/workstream-planner.md)).

## 3. Codex / any skills.sh-compatible agent

```bash
npx skills add chrismarchant/jev-router --skill jev-router
```

This installs `skills/jev-router/SKILL.md`, which works without the MCP server — it tells the agent to use the CLI (`node bin/jev-router.js …`) or to configure the MCP server itself.

## 4. Any MCP client (Cursor, Windsurf, custom harnesses, …)

Point the client at the stdio server:

```json
{
  "mcpServers": {
    "jev-router": {
      "command": "node",
      "args": ["/abs/path/to/jev-router/mcp-server/server.js"],
      "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }
    }
  }
}
```

(See the repo's `.mcp.json` for the full env passthrough with defaults.)

## 5. Any agent that can run shell commands

```bash
npm i -g chrismarchant/jev-router     # optional; provides the `jev-router` bin
# or run straight from the repo:
node bin/jev-router.js help
```

## Keys

| Key | Where to get it | Used by |
|---|---|---|
| `TYPESAFE_API_KEY` | https://console.typesafe.ai/keys (or Vercel AI gateway) | all `jev_*` tools except `jev_draft_options` |
| `MISTRAL_API_KEY` | https://console.mistral.ai | `jev_draft_options` only (default draft model `mistral-small-latest`) |

Never put keys in prompts, `state`, questions, or files the router reads.
