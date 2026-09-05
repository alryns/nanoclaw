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

import { AGENT_NO_PROXY, DATA_DIR, GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { looksLikeCredential } from '../drivers/types.js';
import { registerGatewayProvider, type GatewayProviderInput } from './gateway-provider-registry.js';
import { admitSpawn } from './twyn-lifecycle.js';

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'http://copilot-gateway:4141';

export const TWYN_ENV_FILE = 'twyn-env.json';
/**
 * Per-group gateway endpoint, written by the provisioner under data/twyn-seats, NOT in the group
 * folder: the agent can write and delete files there, and deleting the endpoint file would drop
 * it back onto the platform gateway (review finding 2026-09-05). data/ is never an agent mount.
 */
export const TWYN_SEATS_DIR = path.join(DATA_DIR, 'twyn-seats');
export function twynGatewayFile(folder: string): string {
  return path.join(TWYN_SEATS_DIR, `${folder}.gateway.json`);
}
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
    throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`, { cause: err });
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

/**
 * Read and validate the provisioner-written gateway endpoint for an agent group.
 * The group folder is agent-controlled, so it may only name that group's own
 * internal gateway container.
 */
export async function readGroupGateway(agentGroupId: string): Promise<{ baseUrl: string } | null> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return null;
  const file = twynGatewayFile(group.folder);
  if (!fs.existsSync(file)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${file}: must be valid JSON containing the group's own HTTP gateway URL`, { cause: err });
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof (parsed as { baseUrl?: unknown }).baseUrl !== 'string'
  ) {
    throw new Error(`${file}: must be an object with only a string "baseUrl" for the group's own HTTP gateway`);
  }

  const baseUrl = (parsed as { baseUrl: string }).baseUrl;
  const hostname = `copilot-gateway-${group.folder}`;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (err) {
    throw new Error(`${file}: baseUrl must be http://${hostname}:4141 with no path, query, fragment, or userinfo`, {
      cause: err,
    });
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== hostname ||
    url.port !== '4141' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${file}: baseUrl must be http://${hostname}:4141 with no path, query, fragment, or userinfo`);
  }
  return { baseUrl };
}

registerGatewayProvider('twyn-copilot', () => ({
  kind: 'twyn-copilot',
  async contribute(input: GatewayProviderInput) {
    const groupEnv = await readGroupEnv(input.key.agentGroupId);
    const gateway = await readGroupGateway(input.key.agentGroupId);
    await admitSpawn(input.key.sessionId);
    return {
      env: {
        ...groupEnv,
        ANTHROPIC_BASE_URL: gateway?.baseUrl ?? ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: 'sk-dummy',
        // The runner sets both spellings (agentProxyEnvironment); override both or one client
        // library still routes the gateway through the egress proxy, which denies it.
        ...(gateway
          ? {
              NO_PROXY: `${AGENT_NO_PROXY},${new URL(gateway.baseUrl).hostname}`,
              no_proxy: `${AGENT_NO_PROXY},${new URL(gateway.baseUrl).hostname}`,
            }
          : {}),
      },
    };
  },
}));
