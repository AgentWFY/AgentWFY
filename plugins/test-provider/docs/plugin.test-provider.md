# plugin.test-provider

Test provider for verifying session resilience. Select it from the provider picker, then send messages with special commands to trigger different failure modes.

## Commands

Send any of these as your message:

- **`normal`** — Streams a normal response with simulated thinking + text. Works like a real provider.
- **`network`** — Starts streaming, then throws a network error mid-stream. Tests retry with backoff.
- **`timeout`** — Starts streaming, then goes silent (no events for 90s+). Tests the idle watchdog/stalled indicator.
- **`ratelimit`** — Throws a rate_limit error with a 10s retryAfterMs hint. Tests rate limit retry.
- **`auth`** — Throws an auth error. Tests non-retryable error display (no retry).
- **`overflow`** — Throws a context_overflow error. Tests context overflow handling.
- **`tools`** — Streams a response that includes a tool call (execJs). Tests tool execution through the new callback interface.
- **`thinking`** — Simulates 15 seconds of server-side thinking before the first token. Tests the waiting indicator and verifies status_line keepalives prevent false watchdog triggers.
- **`slow`** — Streams very slowly (1 token/second for 10 tokens). Tests that the watchdog doesn't false-trigger on slow streams.
- **`multi-fail`** — Fails 3 times with network errors, then succeeds on the 4th attempt. Tests multi-retry recovery.
- **`pick`** — Streams a response that includes an execJs tool call calling `pickFromPalette`. Tests the command palette picker flow (pickFromPalette runtime function).

Any other message gets a simple echo response.
