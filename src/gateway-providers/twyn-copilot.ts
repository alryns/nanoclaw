/** TwynOracle's local copilot-gateway provider. */
import { registerGatewayProvider } from './gateway-provider-registry.js';

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'http://copilot-gateway:4141';

registerGatewayProvider('twyn-copilot', () => ({
  kind: 'twyn-copilot',
  async contribute() {
    return {
      env: {
        ANTHROPIC_BASE_URL,
        // copilot-gateway authenticates itself to GitHub; the SDK only needs
        // a non-empty token, so this deliberately contains no credential.
        ANTHROPIC_AUTH_TOKEN: 'sk-dummy',
      },
    };
  },
}));
