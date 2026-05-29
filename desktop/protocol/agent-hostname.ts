import crypto from 'crypto';
import { AGENT_VIEW_HOST_SUFFIX } from '#shared/protocol/view-document.js';

// Deterministic per-agent subdomain. agentId is the agent directory path; we
// hash it because paths aren't valid DNS labels.
export function agentHostname(agentId: string): string {
  const hash = crypto.createHash('sha256').update(agentId).digest('hex').slice(0, 16);
  return `${hash}${AGENT_VIEW_HOST_SUFFIX}`;
}
