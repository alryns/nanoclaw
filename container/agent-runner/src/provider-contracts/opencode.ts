import {
  OPENCODE_EXECUTION_POLICY,
  resolveOpenCodeInference,
  resolveOpenCodeMcpServers,
  resolveOpenCodeMemory,
} from '../providers/opencode.js';
import { registerProviderContract } from '../providers/provider-registry.js';

import type { ProviderRuntimeContract } from './registry.js';

const provider = 'opencode';
// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

export const opencodeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    // The stance is fixed — the container and the OneCLI allow-list are the
    // boundary — so it is declared as the constant it is.
    executionPolicy: { value: OPENCODE_EXECUTION_POLICY },
    inference: {
      resolve: resolveOpenCodeInference,
      // OpenCode selects its model through the OPENCODE_* environment the host
      // provisions, so the core input's `model` and `speed` have no effect on
      // it — only `effort` does, and only for a model the emitted config
      // registers itself (any provider but `anthropic`). The registry's
      // default probes vary `model` alone, which this provider ignores, so the
      // probes declare the environment under which effort is observable.
      probes: {
        a: { effort: 'low' },
        b: { effort: 'high' },
        environment: { OPENCODE_PROVIDER: 'openai', OPENCODE_MODEL: 'openai/nanoclaw-probe-model' },
      },
    },
    // OpenCode has no native session-start hook file; the provider runs the
    // hook command itself when a context window is built, so the capability
    // resolves how that run happens from the hook core registers.
    memory: { resolve: resolveOpenCodeMemory },
    mcpServers: { resolve: resolveOpenCodeMcpServers },
  },
  // OpenCode persists and compacts its own session history under
  // XDG_DATA_HOME: core writes no runtime files for it (the config travels in
  // OPENCODE_CONFIG_CONTENT), archives nothing, and rotates nothing.
  textDelivery: 'result',
  compaction: 'provider-native',
  commands: { formatting: 'xml' },
};

// Two-step registration: providers/opencode.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract(provider, opencodeRuntimeContract);
