// @katnor/llm - provider adapters (Anthropic, OpenAI-compatible, Google, Ollama)
// behind a common LLMProvider interface. See PLAN.md section 4.1.
//
// TODO: implemented in a later phase

export const LLM_PACKAGE_NAME = '@katnor/llm';

export type LlmProviderId = 'anthropic' | 'openai-compatible' | 'google' | 'ollama';
