/**
 * Settings Service
 *
 * Persists NON-SECRET LLM provider preferences (active provider, model,
 * baseUrl, endpoint, deploymentName, apiVersion, temperature, maxTokens) to
 * sessionStorage.
 *
 * Secrets (API keys / auth tokens) are MEMORY-ONLY (R10): they are never
 * written to sessionStorage or localStorage. They live only in the in-memory
 * React state (`llmSettings` in useAppState) for the current session and must
 * be re-entered after a page refresh. `loadSettings` additionally wipes any
 * previously-persisted secrets from both storages (cleanup migration).
 *
 * API keys are sent only to the configured LLM provider when you chat — never
 * to the GitNexus backend.
 */

import {
  LLMSettings,
  DEFAULT_LLM_SETTINGS,
  LLMProvider,
  OpenAIConfig,
  AzureOpenAIConfig,
  GeminiConfig,
  AnthropicConfig,
  OllamaConfig,
  OpenRouterConfig,
  MiniMaxConfig,
  GLMConfig,
  DeepSeekConfig,
  ProviderConfig,
} from './types';
import { DEFAULT_OPENROUTER_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from '../../config/ui-constants';
import { resilientFetch } from 'gitnexus-shared';

const STORAGE_KEY = 'gitnexus-llm-settings';

/**
 * Secret fields that must NEVER be persisted to storage (R10). `apiKey` is the
 * only secret in the current provider configs; `authToken` is listed defensively
 * so any future auth-token field is stripped by default too.
 */
const SECRET_PROVIDER_FIELDS = ['apiKey', 'authToken'] as const;

/** Provider keys on LLMSettings whose config objects may hold secret fields. */
const PROVIDER_KEYS: (keyof LLMSettings)[] = [
  'openai',
  'azureOpenAI',
  'gemini',
  'anthropic',
  'ollama',
  'openrouter',
  'minimax',
  'glm',
  'deepseek',
  'clusteringProvider',
];

/** Remove all secret fields from a single provider-config object (shallow copy). */
const stripSecretsFromConfig = (config: unknown): unknown => {
  if (!config || typeof config !== 'object') return config;
  const clone: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const field of SECRET_PROVIDER_FIELDS) {
    delete clone[field];
  }
  return clone;
};

/**
 * Return a copy of settings with every secret field stripped from every
 * provider config. Used before any write to storage so secrets are never
 * serialized (R10). The returned object is safe to JSON.stringify into storage.
 */
const stripSecrets = (settings: LLMSettings): LLMSettings => {
  // Work on an untyped mutable view so we can rewrite the provider config keys
  // without widening LLMSettings to an index-signature type.
  const out = { ...settings } as unknown as Record<string, unknown>;
  for (const key of PROVIDER_KEYS) {
    const config = out[key as string];
    if (config && typeof config === 'object') {
      out[key as string] = stripSecretsFromConfig(config);
    }
  }
  return out as unknown as LLMSettings;
};

const mergeWithDefaults = (parsed?: Partial<LLMSettings> | null): LLMSettings => ({
  ...DEFAULT_LLM_SETTINGS,
  ...parsed,
  openai: {
    ...DEFAULT_LLM_SETTINGS.openai,
    ...parsed?.openai,
  },
  azureOpenAI: {
    ...DEFAULT_LLM_SETTINGS.azureOpenAI,
    ...parsed?.azureOpenAI,
  },
  gemini: {
    ...DEFAULT_LLM_SETTINGS.gemini,
    ...parsed?.gemini,
  },
  anthropic: {
    ...DEFAULT_LLM_SETTINGS.anthropic,
    ...parsed?.anthropic,
  },
  ollama: {
    ...DEFAULT_LLM_SETTINGS.ollama,
    ...parsed?.ollama,
  },
  openrouter: {
    ...DEFAULT_LLM_SETTINGS.openrouter,
    ...parsed?.openrouter,
  },
  minimax: {
    ...DEFAULT_LLM_SETTINGS.minimax,
    ...parsed?.minimax,
  },
  glm: {
    ...DEFAULT_LLM_SETTINGS.glm,
    ...parsed?.glm,
  },
  deepseek: {
    ...DEFAULT_LLM_SETTINGS.deepseek,
    ...parsed?.deepseek,
  },
});

const readSettings = (storage: Storage): Partial<LLMSettings> | null => {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<LLMSettings>;
  } catch (error) {
    console.warn('Failed to parse LLM settings:', error);
    return null;
  }
};

/** Write NON-SECRET settings to storage. Secrets are stripped first (R10). */
const writeSettings = (storage: Storage, settings: LLMSettings): void => {
  storage.setItem(STORAGE_KEY, JSON.stringify(stripSecrets(settings)));
};

/** True if the raw stored JSON appears to contain any secret field. */
const rawHasSecret = (raw: string | null): boolean =>
  !!raw && SECRET_PROVIDER_FIELDS.some((field) => raw.includes(`"${field}"`));

/**
 * Re-persist a secret-free copy of an already-persisted blob, or remove it.
 * This is the cleanup migration that wipes any secret a previous app version
 * may have written to `storage` (R10). Best-effort: storage errors are ignored.
 */
const wipePersistedSecrets = (storage: Storage, parsed: Partial<LLMSettings>): void => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!rawHasSecret(raw)) return; // nothing secret persisted here
    // Rewrite the stripped, non-secret prefs so the user's choices survive.
    storage.setItem(STORAGE_KEY, JSON.stringify(stripSecrets(mergeWithDefaults(parsed))));
  } catch {
    // ignore — wiping is best-effort
  }
};

/**
 * Load NON-SECRET settings from sessionStorage (migrating legacy localStorage
 * once). Secrets are NEVER returned from storage; key fields come back empty.
 * Any secret previously persisted to either storage is wiped (R10).
 */
export const loadSettings = (): LLMSettings => {
  try {
    const sessionData = typeof sessionStorage !== 'undefined' ? readSettings(sessionStorage) : null;
    if (sessionData) {
      // Cleanup migration: scrub any secret a prior version persisted.
      if (typeof sessionStorage !== 'undefined') wipePersistedSecrets(sessionStorage, sessionData);
      // Also remove any lingering legacy localStorage copy (it may hold a secret).
      if (typeof localStorage !== 'undefined' && rawHasSecret(localStorage.getItem(STORAGE_KEY))) {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      }
      // Strip secrets from the in-memory result too, so callers never see them.
      return stripSecrets(mergeWithDefaults(sessionData));
    }

    const legacyData = typeof localStorage !== 'undefined' ? readSettings(localStorage) : null;
    if (legacyData) {
      const merged = stripSecrets(mergeWithDefaults(legacyData));
      try {
        if (typeof sessionStorage !== 'undefined') {
          writeSettings(sessionStorage, merged);
        }
        if (typeof localStorage !== 'undefined') {
          // Drop the legacy blob entirely — it may contain a persisted secret.
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (error) {
        console.warn('Failed to migrate legacy LLM settings to sessionStorage:', error);
      }
      return merged;
    }

    return DEFAULT_LLM_SETTINGS;
  } catch (error) {
    console.warn('Failed to load LLM settings:', error);
    return DEFAULT_LLM_SETTINGS;
  }
};

/**
 * Save settings to sessionStorage. Secrets are stripped before writing (R10) —
 * the in-memory `settings` argument may carry an API key for the live session,
 * but only its non-secret fields are persisted.
 */
export const saveSettings = (settings: LLMSettings): void => {
  try {
    if (typeof sessionStorage !== 'undefined') {
      writeSettings(sessionStorage, settings);
    }
  } catch (error) {
    console.error('Failed to save LLM settings:', error);
  }
};

/**
 * Update a specific provider's settings
 */
export const updateProviderSettings = <T extends LLMProvider>(
  provider: T,
  updates: Partial<
    T extends 'openai'
      ? Partial<Omit<OpenAIConfig, 'provider'>>
      : T extends 'azure-openai'
        ? Partial<Omit<AzureOpenAIConfig, 'provider'>>
        : T extends 'gemini'
          ? Partial<Omit<GeminiConfig, 'provider'>>
          : T extends 'anthropic'
            ? Partial<Omit<AnthropicConfig, 'provider'>>
            : T extends 'ollama'
              ? Partial<Omit<OllamaConfig, 'provider'>>
              : T extends 'openrouter'
                ? Partial<Omit<OpenRouterConfig, 'provider'>>
                : T extends 'minimax'
                  ? Partial<Omit<MiniMaxConfig, 'provider'>>
                  : T extends 'glm'
                    ? Partial<Omit<GLMConfig, 'provider'>>
                    : T extends 'deepseek'
                      ? Partial<Omit<DeepSeekConfig, 'provider'>>
                      : never
  >,
): LLMSettings => {
  const current = loadSettings();

  // Avoid spreading unions like LLMSettings[keyof LLMSettings] (can be string/undefined)
  switch (provider) {
    case 'openai': {
      const updated: LLMSettings = {
        ...current,
        openai: {
          ...(current.openai ?? {}),
          ...(updates as Partial<Omit<OpenAIConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'azure-openai': {
      const updated: LLMSettings = {
        ...current,
        azureOpenAI: {
          ...(current.azureOpenAI ?? {}),
          ...(updates as Partial<Omit<AzureOpenAIConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'gemini': {
      const updated: LLMSettings = {
        ...current,
        gemini: {
          ...(current.gemini ?? {}),
          ...(updates as Partial<Omit<GeminiConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'anthropic': {
      const updated: LLMSettings = {
        ...current,
        anthropic: {
          ...(current.anthropic ?? {}),
          ...(updates as Partial<Omit<AnthropicConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'ollama': {
      const updated: LLMSettings = {
        ...current,
        ollama: {
          ...(current.ollama ?? {}),
          ...(updates as Partial<Omit<OllamaConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'openrouter': {
      const updated: LLMSettings = {
        ...current,
        openrouter: {
          ...(current.openrouter ?? {}),
          ...(updates as Partial<Omit<OpenRouterConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'minimax': {
      const updated: LLMSettings = {
        ...current,
        minimax: {
          ...(current.minimax ?? {}),
          ...(updates as Partial<Omit<MiniMaxConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'glm': {
      const updated: LLMSettings = {
        ...current,
        glm: {
          ...(current.glm ?? {}),
          ...(updates as Partial<Omit<GLMConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'deepseek': {
      const updated: LLMSettings = {
        ...current,
        deepseek: {
          ...(current.deepseek ?? {}),
          ...(updates as Partial<Omit<DeepSeekConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    default: {
      // Should be unreachable due to T extends LLMProvider, but keep a safe fallback
      const updated: LLMSettings = { ...current };
      saveSettings(updated);
      return updated;
    }
  }
};

/**
 * Set the active provider
 */
export const setActiveProvider = (provider: LLMProvider): LLMSettings => {
  const current = loadSettings();
  const updated: LLMSettings = {
    ...current,
    activeProvider: provider,
  };
  saveSettings(updated);
  return updated;
};

/**
 * Get the current provider configuration
 */
type ProviderBuilder = (settings: LLMSettings) => ProviderConfig | null;

const providerBuilders: Record<LLMProvider, ProviderBuilder> = {
  openai: (settings) => {
    if (!settings.openai?.apiKey) return null;
    return { provider: 'openai', ...settings.openai } as OpenAIConfig;
  },
  'azure-openai': (settings) => {
    if (!settings.azureOpenAI?.apiKey || !settings.azureOpenAI?.endpoint) return null;
    return { provider: 'azure-openai', ...settings.azureOpenAI } as AzureOpenAIConfig;
  },
  gemini: (settings) => {
    if (!settings.gemini?.apiKey) return null;
    return { provider: 'gemini', ...settings.gemini } as GeminiConfig;
  },
  anthropic: (settings) => {
    if (!settings.anthropic?.apiKey) return null;
    return { provider: 'anthropic', ...settings.anthropic } as AnthropicConfig;
  },
  ollama: (settings) => {
    return {
      provider: 'ollama',
      ...settings.ollama,
      baseUrl: settings.ollama?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    } as OllamaConfig;
  },
  openrouter: (settings) => {
    if (!settings.openrouter?.apiKey || settings.openrouter.apiKey.trim() === '') return null;
    return {
      provider: 'openrouter',
      apiKey: settings.openrouter.apiKey,
      model: settings.openrouter.model || '',
      baseUrl: settings.openrouter.baseUrl || DEFAULT_OPENROUTER_BASE_URL,
      temperature: settings.openrouter.temperature,
      maxTokens: settings.openrouter.maxTokens,
    } as OpenRouterConfig;
  },
  minimax: (settings) => {
    if (!settings.minimax?.apiKey) return null;
    return { provider: 'minimax', ...settings.minimax } as MiniMaxConfig;
  },
  glm: (settings) => {
    if (!settings.glm?.apiKey) return null;
    return {
      provider: 'glm',
      apiKey: settings.glm.apiKey,
      model: settings.glm.model || 'GLM-5',
      baseUrl: settings.glm.baseUrl || 'https://api.z.ai/api/coding/paas/v4',
      temperature: settings.glm.temperature,
      maxTokens: settings.glm.maxTokens,
    } as GLMConfig;
  },
  deepseek: (settings) => {
    if (!settings.deepseek?.apiKey) return null;
    return { provider: 'deepseek', ...settings.deepseek } as DeepSeekConfig;
  },
};

/**
 * Build the active provider's runtime config from an IN-MEMORY settings object.
 *
 * Prefer this over `getActiveProviderConfig()` whenever the live React state is
 * available (R10): secrets are memory-only and are stripped from storage, so a
 * config built from `loadSettings()` will lack the API key for key-requiring
 * providers. Pass `llmSettings` (which holds the working key for the session).
 */
export const getProviderConfigFromSettings = (settings: LLMSettings): ProviderConfig | null => {
  const builder = providerBuilders[settings.activeProvider];
  return builder ? builder(settings) : null;
};

/** Check whether the active provider in an in-memory settings object is configured. */
export const isSettingsConfigured = (settings: LLMSettings): boolean =>
  getProviderConfigFromSettings(settings) !== null;

/**
 * Build the active provider config from STORAGE.
 *
 * NOTE (R10): secrets are not persisted, so this returns a usable config only
 * for providers that need no API key (e.g. Ollama). For key-requiring providers
 * use `getProviderConfigFromSettings(llmSettings)` with the in-memory state.
 */
export const getActiveProviderConfig = (): ProviderConfig | null => {
  return getProviderConfigFromSettings(loadSettings());
};

/**
 * Check if the active provider is properly configured, reading from STORAGE.
 *
 * NOTE (R10): for key-requiring providers prefer `isSettingsConfigured(llmSettings)`
 * with the in-memory state, since the persisted prefs never include the key.
 */
export const isProviderConfigured = (): boolean => {
  return getActiveProviderConfig() !== null;
};

/**
 * Clear all settings (reset to defaults)
 */
export const clearSettings = (): void => {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(STORAGE_KEY);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.warn('Failed to clear LLM settings:', error);
  }
};

interface ProviderCapabilities {
  /** Provider requires hidden assistant/tool transcript replay across turns. */
  preserveAssistantTranscript: boolean;
}

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  preserveAssistantTranscript: false,
};

const PROVIDER_CAPABILITIES: Partial<Record<LLMProvider, ProviderCapabilities>> = {
  deepseek: { preserveAssistantTranscript: true },
};

export const getProviderCapabilities = (provider: LLMProvider): ProviderCapabilities => ({
  ...DEFAULT_PROVIDER_CAPABILITIES,
  ...PROVIDER_CAPABILITIES[provider],
});

/**
 * Get display name for a provider
 */
export const getProviderDisplayName = (provider: LLMProvider): string => {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'azure-openai':
      return 'Azure OpenAI';
    case 'gemini':
      return 'Google Gemini';
    case 'anthropic':
      return 'Anthropic';
    case 'ollama':
      return 'Ollama (Local)';
    case 'openrouter':
      return 'OpenRouter';
    case 'minimax':
      return 'MiniMax';
    case 'glm':
      return 'GLM (Z.AI)';
    case 'deepseek':
      return 'DeepSeek';
    default:
      return provider;
  }
};

/**
 * Get available models for a provider
 */
export const getAvailableModels = (provider: LLMProvider): string[] => {
  switch (provider) {
    case 'openai':
      return ['gpt-4.5-preview', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
    case 'azure-openai':
      // Azure models depend on deployment, so we show common ones
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-35-turbo'];
    case 'gemini':
      return ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro'];
    case 'anthropic':
      return [
        'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
      ];
    case 'ollama':
      return ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'deepseek-coder'];
    case 'minimax':
      return ['MiniMax-M2.5', 'MiniMax-M2.5-highspeed'];
    case 'glm':
      return ['GLM-5', 'GLM-5-Turbo', 'GLM-4.7', 'GLM-4.5'];
    case 'deepseek':
      return ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
    default:
      return [];
  }
};

/**
 * Fetch available models from OpenRouter API
 */
export const fetchOpenRouterModels = async (): Promise<Array<{ id: string; name: string }>> => {
  try {
    const response = await resilientFetch(`${DEFAULT_OPENROUTER_BASE_URL}/models`, undefined, {
      breakerKey: 'openrouter-models',
      retry: { maxAttempts: 2, baseDelayMs: 500, capDelayMs: 2_000 },
    });
    if (!response.ok) throw new Error('Failed to fetch models');
    const data = await response.json();
    return data.data.map((model: any) => ({
      id: model.id,
      name: model.name || model.id,
    }));
  } catch (error) {
    console.error('Error fetching OpenRouter models:', error);
    return [];
  }
};
