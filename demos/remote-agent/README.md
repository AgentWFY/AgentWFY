# remote-agent

Demo of using a daemon-backed remote agent from the desktop preview.

## What this demo shows

1. Builds and installs `plugins/test-provider` into a fresh remote agent inside
   the preview container.
2. Starts `agentwfy-remote-server` for that agent.
3. Adds the daemon through the Add Remote Agent command-palette screen.
4. Switches to the remote agent and selects the remote `Test Provider`.
5. Sends `normal`, `slow`, and `tools` prompts through the remote WebSocket
   backend. The `slow` prompt makes remote text streaming visible.
6. Sends `remote-view`, which creates a DB-backed view in the daemon-side
   `agent.db`, waits for the desktop mirror to sync, and opens the view from
   the local copy.

## Recording

```bash
./scripts/preview
./scripts/record-demo --no-test-provider <preview-name> demos/remote-agent
```

The driver provisions its own remote test provider, so the local
`test-provider` bootstrap is not needed.
