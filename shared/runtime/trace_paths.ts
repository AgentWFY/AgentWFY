// Where per-session execution traces live under the agent root. The FileStore
// enforces the private-subtree policy, so callers pass `{ allowPrivate: true }`.
export const TRACES_RELATIVE_DIR = '.agentwfy/traces'
