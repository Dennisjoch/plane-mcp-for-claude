#!/usr/bin/env node
/**
 * Plane MCP server — Model Context Protocol bridge to a Plane instance.
 *
 * Works with Plane Cloud (api.plane.so) and any self-hosted Plane install.
 *
 * Required env:
 *   PLANE_API_KEY         — X-API-Key from your Plane workspace settings
 *   PLANE_BASE_URL        — e.g. https://api.plane.so  or  https://plane.example.com
 *   PLANE_WORKSPACE_SLUG  — e.g. "my-team"  (visible in Plane URLs)
 *
 * Launch:
 *   node index.mjs
 *
 * Configure in ~/.claude.json under "mcpServers":
 *   {
 *     "plane": {
 *       "command": "node",
 *       "args": ["/abs/path/to/index.mjs"],
 *       "env": {
 *         "PLANE_API_KEY": "plane_api_...",
 *         "PLANE_BASE_URL": "https://bugs.example.com",
 *         "PLANE_WORKSPACE_SLUG": "shops"
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const API_KEY = process.env.PLANE_API_KEY
const BASE_URL = (process.env.PLANE_BASE_URL || "").replace(/\/$/, "")
const WORKSPACE = process.env.PLANE_WORKSPACE_SLUG

if (!API_KEY || !BASE_URL || !WORKSPACE) {
  console.error(
    "[plane-mcp] Missing env. Required: PLANE_API_KEY, PLANE_BASE_URL, PLANE_WORKSPACE_SLUG"
  )
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/*  HTTP helper                                                        */
/* ------------------------------------------------------------------ */

async function plane(path, { method = "GET", body, query } = {}) {
  const url = new URL(`${BASE_URL}/api/v1${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue
      url.searchParams.set(k, String(v))
    }
  }

  const init = {
    method,
    headers: {
      "X-API-Key": API_KEY,
      Accept: "application/json",
    },
  }
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }

  const res = await fetch(url, init)
  const text = await res.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }

  if (!res.ok) {
    const snippet =
      typeof payload === "string"
        ? payload.slice(0, 500)
        : JSON.stringify(payload).slice(0, 500)
    throw new Error(
      `Plane ${method} ${url.pathname} → ${res.status}: ${snippet}`
    )
  }

  return payload
}

const wsPath = (suffix = "") =>
  `/workspaces/${encodeURIComponent(WORKSPACE)}${suffix}`

/* ------------------------------------------------------------------ */
/*  Formatters                                                         */
/* ------------------------------------------------------------------ */

function compactIssue(issue) {
  if (!issue) return null
  return {
    id: issue.id,
    sequence_id: issue.sequence_id,
    name: issue.name,
    state: issue.state,
    priority: issue.priority,
    assignees: issue.assignees,
    labels: issue.labels,
    project: issue.project,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    start_date: issue.start_date,
    target_date: issue.target_date,
    completed_at: issue.completed_at,
    parent: issue.parent,
    is_draft: issue.is_draft,
    archived_at: issue.archived_at,
  }
}

function unwrapList(data) {
  if (Array.isArray(data)) return { items: data, next_cursor: null }
  if (data && Array.isArray(data.results)) {
    return { items: data.results, next_cursor: data.next_cursor ?? null }
  }
  return { items: [], next_cursor: null }
}

const asJson = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
})

/* ------------------------------------------------------------------ */
/*  Tools                                                              */
/* ------------------------------------------------------------------ */

const tools = [
  {
    name: "list_projects",
    description: "List all projects in the configured Plane workspace.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Pagination cursor from a previous response",
        },
        per_page: { type: "number", default: 50 },
      },
      additionalProperties: false,
    },
    handler: async ({ cursor, per_page = 50 } = {}) => {
      const data = await plane(wsPath("/projects/"), {
        query: { cursor, per_page: Math.min(100, per_page) },
      })
      const { items, next_cursor } = unwrapList(data)
      return {
        projects: items.map((p) => ({
          id: p.id,
          identifier: p.identifier,
          name: p.name,
          description: p.description,
          archived: p.archived_at !== null && p.archived_at !== undefined,
          icon: p.logo_props?.emoji?.value,
        })),
        next_cursor,
      }
    },
  },

  {
    name: "list_work_items",
    description:
      "List work items (issues) in a project. Supports cursor pagination, `expand` for related fields, and `order_by` (prefix with - for desc).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        cursor: { type: "string" },
        per_page: { type: "number", default: 50 },
        expand: {
          type: "string",
          description:
            "Comma-separated related fields to expand (e.g. 'assignees,labels')",
        },
        order_by: {
          type: "string",
          description:
            "Field to order by, prefix with '-' for descending (e.g. '-created_at')",
        },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id, cursor, per_page = 50, expand, order_by }) => {
      const data = await plane(
        wsPath(`/projects/${project_id}/work-items/`),
        {
          query: {
            cursor,
            per_page: Math.min(100, per_page),
            expand,
            order_by,
          },
        }
      )
      const { items, next_cursor } = unwrapList(data)
      return {
        work_items: items.map(compactIssue),
        next_cursor,
      }
    },
  },

  {
    name: "search_work_items",
    description:
      "Search work items across the whole workspace by query string (matches name/description).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        workspace_search: {
          type: "boolean",
          default: true,
          description:
            "If false, scope search to a single project (requires project_id).",
        },
        project_id: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async ({ query, workspace_search = true, project_id }) => {
      const qp = { search: query, workspace_search: workspace_search ? "true" : "false" }
      if (project_id) qp.project_id = project_id
      const data = await plane(wsPath(`/work-items/search/`), { query: qp })
      const { items } = unwrapList(data)
      return { results: items }
    },
  },

  {
    name: "get_work_item",
    description: "Get full details of a single work item (incl. description).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
      },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id, work_item_id }) => {
      return plane(
        wsPath(`/projects/${project_id}/work-items/${work_item_id}/`)
      )
    },
  },

  {
    name: "create_work_item",
    description: "Create a new work item (issue) in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string", description: "Title (required)" },
        description_html: {
          type: "string",
          description: "HTML description (Plane stores rich HTML)",
        },
        priority: {
          type: "string",
          enum: ["urgent", "high", "medium", "low", "none"],
        },
        state_id: {
          type: "string",
          description:
            "Workflow state UUID (use list_states to look it up). Defaults to project default state.",
        },
        assignee_ids: { type: "array", items: { type: "string" } },
        label_ids: { type: "array", items: { type: "string" } },
        parent_id: { type: "string" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        target_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["project_id", "name"],
      additionalProperties: false,
    },
    handler: async ({ project_id, name, ...rest }) => {
      const body = { name }
      if (rest.description_html !== undefined) body.description_html = rest.description_html
      if (rest.priority !== undefined) body.priority = rest.priority
      if (rest.state_id !== undefined) body.state = rest.state_id
      if (rest.assignee_ids !== undefined) body.assignees = rest.assignee_ids
      if (rest.label_ids !== undefined) body.labels = rest.label_ids
      if (rest.parent_id !== undefined) body.parent = rest.parent_id
      if (rest.start_date !== undefined) body.start_date = rest.start_date
      if (rest.target_date !== undefined) body.target_date = rest.target_date

      return plane(wsPath(`/projects/${project_id}/work-items/`), {
        method: "POST",
        body,
      })
    },
  },

  {
    name: "update_work_item",
    description:
      "Patch-update a work item. Only supplied fields are changed. Use list_states to resolve state_id, list_members for assignees, list_labels for labels.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        name: { type: "string" },
        description_html: { type: "string" },
        priority: {
          type: "string",
          enum: ["urgent", "high", "medium", "low", "none"],
        },
        state_id: { type: "string" },
        assignee_ids: { type: "array", items: { type: "string" } },
        label_ids: { type: "array", items: { type: "string" } },
        start_date: { type: "string" },
        target_date: { type: "string" },
        parent_id: { type: "string" },
      },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id, work_item_id, ...rest }) => {
      const body = {}
      if (rest.name !== undefined) body.name = rest.name
      if (rest.description_html !== undefined) body.description_html = rest.description_html
      if (rest.priority !== undefined) body.priority = rest.priority
      if (rest.state_id !== undefined) body.state = rest.state_id
      if (rest.assignee_ids !== undefined) body.assignees = rest.assignee_ids
      if (rest.label_ids !== undefined) body.labels = rest.label_ids
      if (rest.start_date !== undefined) body.start_date = rest.start_date
      if (rest.target_date !== undefined) body.target_date = rest.target_date
      if (rest.parent_id !== undefined) body.parent = rest.parent_id

      return plane(
        wsPath(`/projects/${project_id}/work-items/${work_item_id}/`),
        { method: "PATCH", body }
      )
    },
  },

  {
    name: "delete_work_item",
    description: "Delete a work item permanently.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
      },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id, work_item_id }) => {
      await plane(
        wsPath(`/projects/${project_id}/work-items/${work_item_id}/`),
        { method: "DELETE" }
      )
      return { deleted: true, work_item_id }
    },
  },

  {
    name: "list_states",
    description:
      "List workflow states (Backlog, Todo, In Progress, Done, Cancelled…) for a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => {
      const data = await plane(wsPath(`/projects/${project_id}/states/`))
      const { items } = unwrapList(data)
      return items.map((s) => ({
        id: s.id,
        name: s.name,
        group: s.group,
        color: s.color,
        default: s.default,
      }))
    },
  },

  {
    name: "list_labels",
    description: "List labels defined in a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => {
      const data = await plane(wsPath(`/projects/${project_id}/labels/`))
      const { items } = unwrapList(data)
      return items.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        description: l.description,
      }))
    },
  },

  {
    name: "list_members",
    description: "List workspace members (id, display name, email, role).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const data = await plane(wsPath(`/members/`))
      const { items } = unwrapList(data)
      return items.map((m) => ({
        id: m.id ?? m.member,
        display_name: m.display_name ?? m.member__display_name,
        email: m.email ?? m.member__email,
        role: m.role,
      }))
    },
  },

  {
    name: "list_comments",
    description: "List comments on a work item (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
      },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id, work_item_id }) => {
      const data = await plane(
        wsPath(
          `/projects/${project_id}/work-items/${work_item_id}/comments/`
        )
      )
      const { items } = unwrapList(data)
      return items
        .slice()
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .map((c) => ({
          id: c.id,
          actor: c.actor_detail?.display_name ?? c.actor,
          comment_html: c.comment_html,
          comment_stripped: c.comment_stripped,
          created_at: c.created_at,
          updated_at: c.updated_at,
        }))
    },
  },

  {
    name: "add_comment",
    description: "Add a comment to a work item.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        comment_html: { type: "string", description: "HTML body" },
      },
      required: ["project_id", "work_item_id", "comment_html"],
      additionalProperties: false,
    },
    handler: async ({ project_id, work_item_id, comment_html }) => {
      return plane(
        wsPath(
          `/projects/${project_id}/work-items/${work_item_id}/comments/`
        ),
        { method: "POST", body: { comment_html } }
      )
    },
  },
]

/* ------------------------------------------------------------------ */
/*  Server wiring                                                      */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: "plane", version: "0.1.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`)
  }
  try {
    const result = await tool.handler(args ?? {})
    return asJson(result)
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err?.message || String(err)}`,
        },
      ],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(
  `[plane-mcp] ready — workspace="${WORKSPACE}" base="${BASE_URL}"`
)
