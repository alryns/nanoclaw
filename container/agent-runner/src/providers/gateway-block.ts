export type GatewayProviderBlock = 'usage_cap_reached' | 'policy_denied';

const GATEWAY_BLOCK_MESSAGES: Record<GatewayProviderBlock, string> = {
  usage_cap_reached:
    'Your organization’s AI usage limit has been reached. Please try again later or contact your administrator.',
  policy_denied: 'Your organization’s AI policy blocked this request. Please contact your administrator.',
};

/**
 * Recognize only the Gateway's canonical terminal provider blocks. The Claude
 * SDK currently surfaces the HTTP response through a result error string, so
 * the agent-runner must require both the status and code instead of guessing
 * from provider prose.
 */
export function classifyGatewayProviderBlock(value: unknown): GatewayProviderBlock | null {
  if (typeof value !== 'string') return null;

  const prefixStatus = apiErrorStatus(value);
  const body = jsonBody(value);
  const bodyStatus = body?.status;
  if (prefixStatus !== null && bodyStatus !== undefined && prefixStatus !== bodyStatus) return null;

  const status = bodyStatus ?? prefixStatus;
  const code = body?.code ?? body?.error;
  if (status === 429 && code === 'usage_cap_reached') return 'usage_cap_reached';
  if (status === 403 && code === 'policy_denied') return 'policy_denied';

  const plain = value.match(/\bAPI Error:\s*(403|429)\s+(usage_cap_reached|policy_denied)\s*$/);
  if (!plain) return null;
  if (plain[1] === '429' && plain[2] === 'usage_cap_reached') return 'usage_cap_reached';
  if (plain[1] === '403' && plain[2] === 'policy_denied') return 'policy_denied';
  return null;
}

export function gatewayProviderBlockMessage(reason: GatewayProviderBlock): string {
  return GATEWAY_BLOCK_MESSAGES[reason];
}

function apiErrorStatus(value: string): number | null {
  const match = value.match(/\bAPI Error:\s*(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function jsonBody(value: string): { status?: number; code?: string; error?: string } | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      status: typeof record.status === 'number' ? record.status : undefined,
      code: typeof record.code === 'string' ? record.code : undefined,
      error: typeof record.error === 'string' ? record.error : undefined,
    };
  } catch {
    return null;
  }
}
