import {
  encodeFamilyModel,
  getModelFamily,
  getModelId,
  getModelSelection,
  isOllamaModel,
  supportsGeminiNativeFeatures,
} from '@/core/types';

describe('model helpers', () => {
  it('keeps Gemini models unprefixed', () => {
    expect(encodeFamilyModel('gemini', 'auto')).toBe('auto');
    expect(getModelFamily('flash')).toBe('gemini');
    expect(supportsGeminiNativeFeatures('flash')).toBe(true);
  });

  it('encodes and decodes Ollama models with a family prefix', () => {
    const encoded = encodeFamilyModel('ollama', 'qwen3:8b');

    expect(encoded).toBe('ollama:qwen3:8b');
    expect(isOllamaModel(encoded)).toBe(true);
    expect(getModelFamily(encoded)).toBe('ollama');
    expect(getModelId(encoded)).toBe('qwen3:8b');
    expect(supportsGeminiNativeFeatures(encoded)).toBe(false);
  });

  it('formats display labels for Gemini and Ollama selections', () => {
    expect(getModelSelection('auto').label).toBe('Gemini Auto');
    expect(getModelSelection('ollama:qwen3:8b').label).toBe('qwen3:8b');
  });
});
