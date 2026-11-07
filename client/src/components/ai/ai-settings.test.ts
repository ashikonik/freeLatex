import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearAiSettings, readAiSettings, storeAiSettings } from './ai-settings.js';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('the settings of the assistant', () => {
  it('finds nothing when nothing was stored', () => {
    expect(readAiSettings()).toBeUndefined();
  });

  it('keeps what was stored', () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });

    expect(readAiSettings()).toEqual({ provider: 'openai', apiKey: 'sk-test' });
  });

  it('reads back the settings that were stored', () => {
    storeAiSettings({ provider: 'anthropic', apiKey: 'sk-test' });

    expect(readAiSettings()?.provider).toBe('anthropic');
  });

  it('forgets the settings when they are cleared', () => {
    storeAiSettings({ provider: 'gemini', apiKey: 'sk-test' });

    clearAiSettings();

    expect(readAiSettings()).toBeUndefined();
  });

  it('ignores a provider it does not know', () => {
    window.localStorage.setItem(
      'freelatex.ai',
      JSON.stringify({ provider: 'nonsense', apiKey: 'sk-test' }),
    );

    expect(readAiSettings()).toBeUndefined();
  });

  it('reads a stored value that is not JSON as no settings', () => {
    window.localStorage.setItem('freelatex.ai', 'not json at all');

    expect(readAiSettings()).toBeUndefined();
  });

  it('reads a missing key as an empty one', () => {
    window.localStorage.setItem('freelatex.ai', JSON.stringify({ provider: 'openai' }));

    expect(readAiSettings()).toEqual({ provider: 'openai', apiKey: '' });
  });
});
