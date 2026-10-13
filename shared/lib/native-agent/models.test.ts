import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { createProvider } from '@earendil-works/pi-ai';
import {
  clearActiveNativeModels,
  createNativeModelsCollection,
  createScriptedTestModels,
  getActiveNativeModels,
  setActiveNativeModels,
} from './models.ts';

describe('native-agent models collection', () => {
  afterEach(() => {
    clearActiveNativeModels();
  });

  it('exposes the built-in openai and openrouter providers', () => {
    const models = createNativeModelsCollection({
      env: {
        OPENAI_API_KEY: 'sk-openai-test',
        OPENROUTER_API_KEY: 'sk-openrouter-test',
      },
    });

    const openai = models.getProvider('openai');
    const openrouter = models.getProvider('openrouter');
    assert(openai, 'expected openai provider');
    assert(openrouter, 'expected openrouter provider');
    assert.equal(openai.id, 'openai');
    assert.equal(openrouter.id, 'openrouter');
  });

  it('resolves api-key auth from the injected env map', async () => {
    const models = createNativeModelsCollection({
      env: { OPENAI_API_KEY: 'sk-from-env' },
    });

    const auth = await models.getAuth('openai');
    assert(auth, 'expected openai auth to resolve');
    assert.equal(auth.auth.apiKey, 'sk-from-env');
  });

  it('returns undefined when the env map omits the canonical name', async () => {
    const models = createNativeModelsCollection({ env: {} });
    const auth = await models.getAuth('openai');
    assert.equal(auth, undefined);
  });

  it('treats blank env values as unset', async () => {
    const models = createNativeModelsCollection({
      env: { OPENROUTER_API_KEY: '   ' },
    });
    const auth = await models.getAuth('openrouter');
    assert.equal(auth, undefined);
  });

  it('accepts scripted providers on a separate collection without touching live providers', () => {
    const scripted = createScriptedTestModels();
    const scriptedProvider = createProvider({
      id: 'scripted',
      name: 'Scripted',
      baseUrl: 'http://local/mock',
      auth: {
        apiKey: {
          name: 'scripted',
          async resolve() {
            return { auth: { apiKey: 'scripted' }, source: 'scripted' };
          },
        },
      },
      models: [],
      api: {
        'openai-responses': {
          stream: () => {
            throw new Error('unreachable: scripted stream not wired');
          },
          streamSimple: () => {
            throw new Error('unreachable: scripted streamSimple not wired');
          },
        },
      },
    });
    scripted.setProvider(scriptedProvider);

    assert(scripted.getProvider('scripted'));
    // The live collection must stay independent of the scripted one.
    const live = createNativeModelsCollection({ env: {} });
    assert.equal(live.getProvider('scripted'), undefined);
  });

  it('tracks the active native models pointer', () => {
    assert.equal(getActiveNativeModels(), undefined);
    const scripted = createScriptedTestModels();
    setActiveNativeModels(scripted);
    assert.equal(getActiveNativeModels(), scripted);
    clearActiveNativeModels();
    assert.equal(getActiveNativeModels(), undefined);
  });
});
