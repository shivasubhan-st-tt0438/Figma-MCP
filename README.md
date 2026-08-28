# Figma MCP

A [Model Context Protocol](https://modelcontextprotocol.io/introduction) server that gives an AI coding agent access to Figma design data — layout, styling, components, and content — so it can implement a design directly instead of working from a screenshot or a description.

This is a customized fork of the Framelink Figma MCP, tuned for one thing: feeding Figma design data to an AI agent implementing a native macOS AppKit app. It is **not** the public `figma-developer-mcp` npm package — don't `npx` it, run it from this repo.

## Prerequisites

- **Node.js ≥ 20.20.0** ([nodejs.org](https://nodejs.org))
- **pnpm** (`npm install -g pnpm`)
- **A Figma Personal Access Token** — [create one here](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens). It needs `File content: Read` and `Dev resources: Read` scopes.

## Install

```bash
git clone <this-repo-url>
cd Figma-MCP
pnpm install
```

## Configure

Copy `.env.example` to `.env` (or create `.env` directly) and set at minimum:

```bash
FIGMA_API_KEY=your_figma_personal_access_token
```

Everything else has a working default. The full set of options — all can also be passed as CLI flags instead (`--figma-api-key`, `--port`, `--format`, etc. — run `node dist/bin.js --help` after building):

| Variable                          | Default       | Purpose                                                                                                                                            |
| --------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIGMA_API_KEY`                   | —             | Your Figma Personal Access Token (required unless using `FIGMA_OAUTH_TOKEN`)                                                                       |
| `PORT`                            | `3333`        | HTTP server port                                                                                                                                   |
| `FRAMELINK_HOST`                  | `127.0.0.1`   | Bind address — set `0.0.0.0` to accept connections from other machines, not just this one                                                          |
| `FIGMA_PROXY`                     | —             | HTTP proxy URL, or `none` to bypass any `HTTP_PROXY`/`HTTPS_PROXY` already set in the environment                                                  |
| `OUTPUT_FORMAT`                   | `native-yaml` | `native-yaml` / `native-json` (compact, fully-inlined) or the legacy `yaml` / `json` / `tree`                                                      |
| `FIGMA_COLOR_TOKENS_DIR`          | —             | Directory of DTCG color-token JSON exports (e.g. `Light.tokens.json`) used to resolve Figma Variable-bound fills to real design-system color names |
| `FIGMA_MCP_FETCH_VARIANTS`        | `false`       | Whether a fetch also pulls each remote component's full variant UI into a second document (costs an extra API call per new component set)          |
| `FIGMA_MCP_NATIVE_LIBRARY_PREFIX` | `macos`       | Slugified name prefix that identifies your platform's own native UI kit library, vs. a custom one                                                  |
| `FIGMA_MCP_VARIANT_CACHE_DIR`     | OS temp dir   | Where fetched variant data is cached (only relevant if `FIGMA_MCP_FETCH_VARIANTS=true`)                                                            |

## Build

```bash
pnpm build
```

Compiles `src/` to `dist/` via `tsup`. Re-run this after pulling any code change.

## Run

```bash
pnpm start
# same as: node dist/bin.js
```

### Or: running a build someone already shared with you

If you received a folder that already has `dist/` in it (someone else ran `pnpm build` and handed you the output, instead of you cloning the source) — skip Install and Build entirely:

1. Install Node.js ≥ 20.20.0 if it isn't already ([nodejs.org](https://nodejs.org)).
2. If the folder has no `node_modules/`, install dependencies once: `npm install --omit=dev` (run inside that folder). If it already includes `node_modules/`, you can normally use it.
3. Make sure `.env` exists in that folder with at least `FIGMA_API_KEY` set (see [Configure](#configure) above).
4. Run it — same command either way:
   ```bash
   node dist/bin.js
   ```

## Connect an MCP client

Use `localhost` for the URL when the client is on the same machine as the running server, or that machine's LAN IP (e.g. `192.168.x.x`) when connecting from a different machine — never both, and never `0.0.0.0` (that's a bind address, not something you can connect _to_).

### Cursor

Cursor Settings → MCP → "Add new global MCP server" (or create `.cursor/mcp.json` in the project root instead of `~/.cursor/mcp.json` for a project-scoped one):

```json
{
  "mcpServers": {
    "figma": {
      "url": "http://localhost:3333/mcp"
    }
  }
}
```

Reload the MCP servers list in Cursor's MCP settings panel afterward — `figma` should show connected with a green dot.

### Claude Code

```bash
claude mcp add --transport http figma http://localhost:3333/mcp
```

Writes to `.mcp.json` (project-scoped, shareable via git) or `~/.claude.json` (user-scoped) for you — no manual JSON needed. Verify with `claude mcp list`; inside a session, `/mcp` shows live status.

### VS Code

Create `.vscode/mcp.json` in the project root:

```json
{
  "servers": {
    "figma": {
      "type": "http",
      "url": "http://localhost:3333/mcp"
    }
  }
}
```

VS Code picks this up the next time you open a Copilot Chat/agent session in this project — note the `"servers"` key and required `"type"`, both different from Cursor/Claude Code's `"mcpServers"` shape.

## Learn more

- [`prompts/project-directive.md`](prompts/project-directive.md) — the rules embedded in every response, guiding how an agent should use the fetched data
- [`prompts/consumption-guide.md`](prompts/consumption-guide.md) — how to read the compact output format itself
