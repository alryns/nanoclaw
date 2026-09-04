/**
 * TwynOracle's gateway provider: copilot-gateway, no OneCLI.
 *
 * Two contributions per spawn:
 * 1. The model endpoint. copilot-gateway authenticates itself to GitHub; the SDK only
 *    needs a non-empty token, so the token is a deliberate dummy that is too short to be
 *    credential-shaped (drivers/types.ts looksLikeCredential).
 * 2. Per-group env from `groups/<folder>/twyn-env.json`, written by the platform's
 *    provisioner (TWYNBRAIN_READONLY, the gate-record path, ...). NanoClaw has no per-group
 *    env column, and this seam is the one pure-addition path into the agent's environment.
 *    Fail-closed, as the seam documents: a malformed or credential-shaped file aborts the
 *    spawn (the inbound message stays pending) rather than launching a misconfigured agent.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { looksLikeCredential } from '../drivers/types.js';
import { registerGatewayProvider, type GatewayProviderInput } from './gateway-provider-registry.js';

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'http://copilot-gateway:4141';

export const TWYN_ENV_FILE = 'twyn-env.json';
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** Keys the file may never override: they define the model plane, not the group. */
const RESERVED = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);

/**
 * Read and validate the provisioner-written env file for an agent group. Absent file =
 * empty contribution (a group provisioned before the file existed still spawns).
 */
export async function readGroupEnv(agentGroupId: string): Promise<Record<string, string>> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return {};
  const file = path.join(GROUPS_DIR, group.folder, TWYN_ENV_FILE);
  if (!fs.existsSync(file)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object of string values`);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ENV_NAME_RE.test(key)) throw new Error(`${file}: "${key}" is not an environment variable name`);
    if (RESERVED.has(key)) throw new Error(`${file}: "${key}" is reserved for the gateway provider`);
    if (typeof value !== 'string') throw new Error(`${file}: "${key}" must be a string`);
    // Secrets never ride the env: the agent has full shell and `env` is one command away.
    // Cookies and tokens go to a 0600 file in the group folder; only paths come through here.
    if (looksLikeCredential(value)) throw new Error(`${file}: "${key}" looks like a credential; refusing`);
    env[key] = value;
  }
  return env;
}

registerGatewayProvider('twyn-copilot', () => ({
  kind: 'twyn-copilot',
  async contribute(input: GatewayProviderInput) {
    return {
      env: {
        ...(await readGroupEnv(input.key.agentGroupId)),
        ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: 'sk-dummy',
      },
    };
  },
}));
