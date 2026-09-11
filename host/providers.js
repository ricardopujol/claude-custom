'use strict';
/**
 * Which backend the hosted `claude` talks to.
 *
 * This is the core bet paying off again: the provider is a property of the
 * PROCESS, so switching it is environment variables on the pty the host already
 * builds. Verified against the binary, which honours ANTHROPIC_BASE_URL,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_MODEL and
 * ANTHROPIC_SMALL_FAST_MODEL.
 *
 * IMPORTANT: Claude Code speaks the Anthropic Messages API and OpenRouter is
 * OpenAI-compatible. They are NOT wire compatible, so a translating proxy
 * (claude-code-router, LiteLLM) has to sit between, with ANTHROPIC_BASE_URL
 * pointed at it.
 *
 * The real risk is not plumbing but TOOL-USE FIDELITY: the whole harness leans
 * on Task, hooks and structured tool output, and non-Claude models vary from
 * fine to unusable, failing by silent degradation rather than by error. The
 * hook bridge already counts tool calls and errors, so a provider can be scored
 * on tool success rate before being trusted.
 *
 * Switching takes effect when the session starts. The pty environment is fixed
 * at spawn, so changing provider means a new session, not a hot swap.
 */

const PROVIDERS = {
  'claude-max': {
    label: 'Claude Max',
    metered: false,          // marginal cost inside quota is zero
    needs: [],
  },
  openrouter: {
    label: 'OpenRouter',
    metered: true,           // every token is real money
    needs: ['baseUrl', 'apiKey'],
  },
};

const DEFAULT_PROVIDER = 'claude-max';

function buildProviderEnv(config = {}) {
  const name = config.provider || DEFAULT_PROVIDER;
  const spec = PROVIDERS[name];

  // An unknown provider falls back rather than half-configuring: a partially
  // applied provider would run against Anthropic while the UI claimed
  // otherwise, and the spend would land somewhere unexpected.
  if (!spec || name === DEFAULT_PROVIDER) return {};

  for (const key of spec.needs) {
    if (!config[key]) {
      throw new Error(`provider ${name}: ${key} is required`);
    }
  }

  const env = {
    ANTHROPIC_BASE_URL: config.baseUrl,
    // AUTH_TOKEN rather than API_KEY: the proxy authenticates the caller, and
    // API_KEY carries Anthropic-specific handling we do not want here.
    ANTHROPIC_AUTH_TOKEN: config.apiKey,
  };
  if (config.model) env.ANTHROPIC_MODEL = config.model;
  // Claude Code uses a cheaper model for background work. Left unset it asks
  // the proxy for an Anthropic model name OpenRouter has never heard of.
  if (config.smallModel) env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;

  return env;
}

/** Safe to log and to show in the UI: never includes the key. */
function describeProvider(config = {}) {
  const name = config.provider || DEFAULT_PROVIDER;
  const spec = PROVIDERS[name] || PROVIDERS[DEFAULT_PROVIDER];
  return {
    provider: PROVIDERS[name] ? name : DEFAULT_PROVIDER,
    label: spec.label,
    metered: spec.metered,
    model: config.model || null,
    baseUrl: config.baseUrl || null,
  };
}

module.exports = { buildProviderEnv, describeProvider, PROVIDERS, DEFAULT_PROVIDER };
