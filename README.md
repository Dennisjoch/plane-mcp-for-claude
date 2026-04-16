# Plane MCP for Claude

A Model Context Protocol (MCP) server that connects [Plane](https://plane.so) to Claude. Works with Plane Cloud (`api.plane.so`) and any self-hosted instance.

Exposes Plane's REST API as tools that Claude (Desktop, Code, or any MCP-aware client) can use to read, create, and update projects, work items (issues), comments, states, labels, and workspace members.

## Install

### Option A: Claude Desktop (recommended)

The easiest way. Install as a native Desktop Extension (`.dxt`):

1. Download `plane-mcp.dxt` from the latest [GitHub release](https://github.com/dennisjoch/plane-mcp-for-claude/releases).
2. Double-click the file, or open Claude Desktop → **Settings → Extensions** and drag it in.
3. Fill in the three fields in the install dialog:
   - **Plane API Key**
   - **Plane Base URL** (e.g. `https://api.plane.so` or your self-hosted URL)
   - **Workspace Slug**
4. Click Install. The Plane tools appear in the MCP tool list right away.

### Option B: Claude Code / manual

```bash
git clone https://github.com/dennisjoch/plane-mcp-for-claude.git
cd plane-mcp-for-claude
npm install
```

Add to `~/.claude.json` (or an `.mcp.json` at your project root):

```json
{
  "mcpServers": {
    "plane": {
      "command": "node",
      "args": ["/absolute/path/to/plane-mcp-for-claude/index.mjs"],
      "env": {
        "PLANE_API_KEY": "plane_api_xxx",
        "PLANE_BASE_URL": "https://api.plane.so",
        "PLANE_WORKSPACE_SLUG": "your-slug"
      }
    }
  }
}
```

Restart Claude Code. The Plane tools will appear in the MCP tool list.

## Get an API token

In Plane, open **Workspace Settings → API Tokens** and create a new token. Copy the value; you won't see it again.

The workspace slug is visible in every Plane URL: `https://plane.example.com/<slug>/projects/…`.

## Tools

| Tool | Purpose |
|------|---------|
| `list_projects` | List all projects in the workspace |
| `list_work_items` | List work items (issues) in a project |
| `search_work_items` | Full-text search across the workspace |
| `get_work_item` | Fetch a single work item with full description |
| `create_work_item` | Create a new issue |
| `update_work_item` | Patch fields of an existing issue |
| `delete_work_item` | Permanently delete an issue |
| `list_states` | List workflow states (Backlog, Todo, …) for a project |
| `list_labels` | List labels defined in a project |
| `list_members` | List workspace members |
| `list_comments` | List comments on a work item |
| `add_comment` | Post a comment on a work item |

## Environment

Used by Option B (manual install). Option A collects these through the Claude Desktop install dialog.

| Variable | Required | Example |
|----------|----------|---------|
| `PLANE_API_KEY` | yes | `plane_api_1a2b3c…` |
| `PLANE_BASE_URL` | yes | `https://api.plane.so` or `https://plane.example.com` |
| `PLANE_WORKSPACE_SLUG` | yes | `my-team` |

No trailing slash on the base URL.

## Building the DXT (contributors)

You only need this if you want to produce your own `.dxt` file:

```bash
npm install        # install runtime deps into node_modules/
npm run validate   # lint the manifest
npm run build      # produces plane-mcp.dxt in the repo root
```

The build uses the official [`@anthropic-ai/dxt`](https://www.npmjs.com/package/@anthropic-ai/dxt) packer via `npx`, so no extra global install is required. The resulting `.dxt` is a zip of the source plus `node_modules/` that Claude Desktop can install directly.

## License

[MIT](LICENSE)
