---
"@openma/sdk": patch
"@openma/cli": patch
---

Pi harness skill mounting strategies (`skill_mount`: `progressive` default, `budgeted`, `tool`, `inline`) replace default full SKILL.md system-prompt inlining for default/Pi harnesses. Deferred skills in `budgeted` mode are discoverable via `tool_search`; `tool` mode adds a `skill` loader tool.
