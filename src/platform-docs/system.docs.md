# system.docs

Docs are stored in the docs table (target="agent"). Schema: id, name (unique), content, updated_at.

## Naming

- `system.*` — app platform docs, read-only (writes will be rejected).
- Everything else is agent-managed.

## Preload

Docs whose name contains no dots (e.g. `system`, `notes`) are automatically included in the system prompt at startup. Docs with dots in the name (e.g. `system.views`, `my.reference`) are read on demand.
