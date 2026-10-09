---
"@openma/sdk": patch
"@openma/cli": patch
---

Document that agents use the Pi agent-core harness by default. The `ai-sdk` harness (legacy AI SDK default-loop) remains available but is deprecated and emits a one-time `session.warning` per session. CLI agent help notes `ai-sdk` is deprecated.
