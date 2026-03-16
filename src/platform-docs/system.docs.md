---
preload: 0
---
# system.docs

Docs are stored in the docs table (target="agent"). Schema: id, name (unique), content, preload (0|1), updated_at.

## Naming

- `system.*` — app platform docs, read-only (writes will be rejected).
- Everything else is agent-managed.

## Preload

preload=1 docs are included in the system prompt at startup.
preload=0 docs are read on demand.
