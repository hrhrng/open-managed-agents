---
"@openma/sdk": patch
"@openma/cli": patch
---

Document agent metadata for deferred MCP `tool_search`: `tool_search` (`auto` | `on` | `off`, default `auto`), optional `tool_search_limit`, `tool_search_auto_threshold`, and `tool_search_always_load`. Backward compatible — omitting `tool_search` keeps automatic exposure when MCP tool definitions exceed a fraction of the model context window.
