import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';
import '../provider-contracts/index.js';
import { getProviderRuntimeContract, validateProviderRuntimeInstance } from '../provider-contracts/registry.js';
import {
  archiveProviderExchangeFromContract,
  maybeRotateProviderContinuation,
  realizeProviderManagedFiles,
  setProviderRuntimeOptions,
} from '../provider-contracts/realize.js';

export function createProvider(name: string, options: ProviderOptions = {}): AgentProvider {
  const contract = getProviderRuntimeContract(name);
  let instance: AgentProvider | undefined;
  const provider = getProviderFactory(name)(
    contract
      ? {
          ...options,
          coreIo: {
            realizeManagedFiles: (when, context) => realizeProviderManagedFiles(name, when, context, instance),
          },
        }
      : options,
  );
  instance = provider;
  if (contract) {
    setProviderRuntimeOptions(provider, options);
    validateProviderRuntimeInstance(name, contract, provider);

    if (contract.archives?.trigger === 'exchange-complete') {
      provider.onExchangeComplete = (exchange) => {
        archiveProviderExchangeFromContract(name, exchange);
      };
    }

    if (contract.continuationRotation) {
      provider.maybeRotateContinuation = (continuation) =>
        maybeRotateProviderContinuation(name, continuation, options.assistantName, (message) =>
          console.error(`[${name}-provider] ${message}`),
        );
    }
  }
  return provider;
}
