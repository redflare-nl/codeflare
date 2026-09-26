import { describe, expect, it } from 'vitest';
import { VLLMClient } from '../src/llm/client';

/**
 * Regression: VLLMClient.config() once called itself (a blanket rename turned
 * `getConfig()` into `this.config()`), so EVERY model call threw
 * "Maximum call stack size exceeded". No test exercised a client method, so it
 * shipped. describe() goes through config(); if it returns, the recursion is gone.
 */

describe('VLLMClient configuration', () => {
  it('resolves the live settings without recursing', () => {
    const client = new VLLMClient();
    expect(() => client.describe()).not.toThrow();
    expect(client.describe()).toMatch(/^local:/); // provider default under the test stub
  });

  it('a pinned target overrides provider, endpoint and model but nothing else', () => {
    const judge = new VLLMClient({ provider: 'openai', endpoint: 'https://api.openai.com', model: 'gpt-4o' });
    expect(judge.describe()).toBe('openai:gpt-4o');
    // The unpinned client is unaffected by the existence of a pinned one.
    expect(new VLLMClient().describe()).toMatch(/^local:/);
  });
});
