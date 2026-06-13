import { describe, expect, it } from 'vitest';
import {
  loadSettings,
  saveSettings,
  setActiveProvider,
  updateProviderSettings,
  getActiveProviderConfig,
  getProviderConfigFromSettings,
  isProviderConfigured,
  isSettingsConfigured,
  clearSettings,
  getProviderDisplayName,
  getAvailableModels,
  getProviderCapabilities,
} from '../../src/core/llm/settings-service';

const STORAGE_KEY = 'gitnexus-llm-settings';

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    const settings = loadSettings();
    expect(settings.activeProvider).toBeDefined();
    expect(settings.openai).toBeDefined();
    expect(settings.ollama).toBeDefined();
  });

  it('merges stored values with defaults', () => {
    sessionStorage.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'ollama',
        ollama: { model: 'qwen3-coder:30b' },
      }),
    );

    const settings = loadSettings();
    expect(settings.activeProvider).toBe('ollama');
    expect(settings.ollama.model).toBe('qwen3-coder:30b');
    // Should still have other provider defaults
    expect(settings.openai).toBeDefined();
  });

  it('returns defaults on corrupted JSON', () => {
    sessionStorage.setItem('gitnexus-llm-settings', 'not-json{{{');
    const settings = loadSettings();
    expect(settings.activeProvider).toBeDefined();
  });

  it('migrates legacy localStorage to sessionStorage', () => {
    localStorage.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'ollama',
        ollama: { model: 'migrated-model' },
      }),
    );

    const settings = loadSettings();
    expect(settings.ollama.model).toBe('migrated-model');
    expect(sessionStorage.getItem('gitnexus-llm-settings')).not.toBeNull();
    expect(localStorage.getItem('gitnexus-llm-settings')).toBeNull();
  });
});

describe('saveSettings / clearSettings', () => {
  it('persists settings to sessionStorage', () => {
    const settings = loadSettings();
    settings.activeProvider = 'anthropic';
    saveSettings(settings);
    expect(loadSettings().activeProvider).toBe('anthropic');
  });

  it('clearSettings removes settings from both storages', () => {
    saveSettings({ ...loadSettings(), activeProvider: 'anthropic' });
    expect(sessionStorage.getItem('gitnexus-llm-settings')).not.toBeNull();
    clearSettings();
    expect(sessionStorage.getItem('gitnexus-llm-settings')).toBeNull();
    expect(localStorage.getItem('gitnexus-llm-settings')).toBeNull();
  });
});

describe('setActiveProvider', () => {
  it('changes the active provider and persists', () => {
    setActiveProvider('gemini');
    expect(loadSettings().activeProvider).toBe('gemini');
  });
});

// ===========================================================================
// R10 — memory-only API keys: secrets are NEVER written to storage.
// ===========================================================================
describe('R10 — secrets are never persisted', () => {
  it('updateProviderSettings does not write apiKey to sessionStorage or localStorage', () => {
    updateProviderSettings('openai', { apiKey: 'sk-secret', model: 'gpt-4o' });

    const sessionRaw = sessionStorage.getItem(STORAGE_KEY) ?? '';
    const localRaw = localStorage.getItem(STORAGE_KEY) ?? '';

    // The secret value must appear in neither store, nor the apiKey field name.
    expect(sessionRaw).not.toContain('sk-secret');
    expect(localRaw).not.toContain('sk-secret');
    expect(sessionRaw).not.toContain('apiKey');
    expect(localRaw).not.toContain('apiKey');
  });

  it('persists non-secret prefs (model) while stripping the secret', () => {
    updateProviderSettings('openai', { apiKey: 'sk-secret', model: 'gpt-4o-mini' });

    const sessionRaw = sessionStorage.getItem(STORAGE_KEY) ?? '';
    expect(sessionRaw).toContain('gpt-4o-mini');

    // The returned in-memory object keeps the secret for the live session...
    const updated = updateProviderSettings('openai', { apiKey: 'sk-live' });
    expect(updated.openai?.apiKey).toBe('sk-live');
    // ...but reloading from storage yields an empty key.
    expect(loadSettings().openai?.apiKey ?? '').toBe('');
  });

  it('saveSettings strips secrets before writing', () => {
    const settings = loadSettings();
    settings.activeProvider = 'anthropic';
    settings.anthropic = { ...settings.anthropic, apiKey: 'sk-ant-xyz', model: 'claude' };
    saveSettings(settings);

    const sessionRaw = sessionStorage.getItem(STORAGE_KEY) ?? '';
    expect(sessionRaw).not.toContain('sk-ant-xyz');
    expect(sessionRaw).toContain('anthropic'); // non-secret block still persisted
  });

  it('loadSettings wipes a pre-seeded legacy apiKey from BOTH storages', () => {
    // Simulate a previously-persisted secret in session AND legacy localStorage.
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ activeProvider: 'openai', openai: { apiKey: 'sk-old', model: 'gpt-4o' } }),
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeProvider: 'openai',
        openai: { apiKey: 'sk-legacy', model: 'gpt-4o' },
      }),
    );

    const loaded = loadSettings();
    // No secret is returned...
    expect(loaded.openai?.apiKey ?? '').toBe('');
    // ...and the wipe re-persisted a secret-free copy / removed the legacy key.
    const sessionRaw = sessionStorage.getItem(STORAGE_KEY) ?? '';
    expect(sessionRaw).not.toContain('sk-old');
    expect(sessionRaw).not.toContain('apiKey');
    const localRaw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(localRaw).not.toContain('sk-legacy');
    expect(localRaw).not.toContain('apiKey');
  });
});

describe('getActiveProviderConfig', () => {
  it('returns null for unconfigured providers requiring API keys', () => {
    setActiveProvider('openai');
    expect(getActiveProviderConfig()).toBeNull();
  });

  it('returns config for ollama without API key', () => {
    setActiveProvider('ollama');
    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('ollama');
  });

  it('builds an openai config from IN-MEMORY settings with an API key', () => {
    // R10: the key lives only in memory; getProviderConfigFromSettings reads it.
    const settings = loadSettings();
    settings.activeProvider = 'openai';
    settings.openai = { ...settings.openai, apiKey: 'sk-test-123' };

    const config = getProviderConfigFromSettings(settings);
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
    expect((config as { apiKey: string }).apiKey).toBe('sk-test-123');
  });

  it('does NOT recover an openai key from storage after saveSettings (R10)', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openai';
    settings.openai = { ...settings.openai, apiKey: 'sk-test-123' };
    saveSettings(settings);

    // Storage-backed lookup has no key → null for a key-requiring provider.
    expect(getActiveProviderConfig()).toBeNull();
  });

  it('builds a deepseek config from IN-MEMORY settings with an API key', () => {
    const settings = loadSettings();
    settings.activeProvider = 'deepseek';
    settings.deepseek = { ...settings.deepseek, apiKey: 'sk-deepseek-123' };

    const config = getProviderConfigFromSettings(settings);
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('deepseek');
  });

  it('returns null for openrouter with empty API key', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openrouter';
    settings.openrouter = { ...settings.openrouter, apiKey: '  ' };
    saveSettings(settings);

    expect(getActiveProviderConfig()).toBeNull();
  });
});

describe('isProviderConfigured', () => {
  it('returns false when provider requires API key and none is set', () => {
    // Manually build a clean openai config with no API key
    saveSettings({
      ...loadSettings(),
      activeProvider: 'openai',
      openai: { apiKey: '', model: 'gpt-4o', temperature: 0.1 },
    });
    expect(isProviderConfigured()).toBe(false);
  });

  it('returns true for ollama (no key required)', () => {
    setActiveProvider('ollama');
    expect(isProviderConfigured()).toBe(true);
  });
});

describe('isSettingsConfigured (in-memory)', () => {
  it('returns true when the in-memory settings carry the required key', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openai';
    settings.openai = { ...settings.openai, apiKey: 'sk-in-memory', model: 'gpt-4o' };
    expect(isSettingsConfigured(settings)).toBe(true);
  });

  it('returns false when the required key is missing', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openai';
    settings.openai = { ...settings.openai, apiKey: '', model: 'gpt-4o' };
    expect(isSettingsConfigured(settings)).toBe(false);
  });
});

describe('getProviderDisplayName', () => {
  it('returns human-readable names', () => {
    expect(getProviderDisplayName('openai')).toBe('OpenAI');
    expect(getProviderDisplayName('azure-openai')).toBe('Azure OpenAI');
    expect(getProviderDisplayName('gemini')).toBe('Google Gemini');
    expect(getProviderDisplayName('anthropic')).toBe('Anthropic');
    expect(getProviderDisplayName('ollama')).toBe('Ollama (Local)');
    expect(getProviderDisplayName('openrouter')).toBe('OpenRouter');
    expect(getProviderDisplayName('deepseek')).toBe('DeepSeek');
  });
});

describe('getAvailableModels', () => {
  it('returns models for known providers', () => {
    expect(getAvailableModels('openai').length).toBeGreaterThan(0);
    expect(getAvailableModels('ollama').length).toBeGreaterThan(0);
    expect(getAvailableModels('anthropic')).toContain('claude-sonnet-4-20250514');
    expect(getAvailableModels('deepseek')).toContain('deepseek-v4-flash');
  });

  it('returns empty array for unknown provider', () => {
    expect(getAvailableModels('unknown' as any)).toEqual([]);
  });
});

describe('getProviderCapabilities', () => {
  it('enables transcript replay only for providers that require it', () => {
    expect(getProviderCapabilities('deepseek').preserveAssistantTranscript).toBe(true);
    expect(getProviderCapabilities('openai').preserveAssistantTranscript).toBe(false);
    expect(getProviderCapabilities('anthropic').preserveAssistantTranscript).toBe(false);
  });
});
