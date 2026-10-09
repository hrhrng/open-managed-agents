---
"@openma/sdk": patch
"@openma/cli": patch
---

Pi agent-core is the default harness; legacy `ai-sdk` remains available but deprecated (one-time `session.warning` per session). Agents accept compaction via `_oma.context_management` (Anthropic Messages shape) or `_oma.model_settings` (OpenAI Agents SDK shape); conflicting dual definitions are rejected at save time.
