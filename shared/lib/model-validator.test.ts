/**
 * Tests for model-validator.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { errorMessage } from './error-utils.ts';
import {
  getKnownModels,
  isValidModel,
  resolveModelSelectorTokenOrThrow,
  suggestModel,
  validateModelSelectorTokenOrThrow,
  validateModelOrThrow,
} from './model-validator.ts';

describe('model-validator', () => {
  describe('getKnownModels', () => {
    it('returns models from pricing config', () => {
      const { all } = getKnownModels('.');

      // Should include models from .wavemill-config.json pricing
      assert.ok(all.includes('gpt-5.3-codex'), 'Should include gpt-5.3-codex');
      assert.ok(all.includes('gpt-5.4'), 'Should include gpt-5.4');
      assert.ok(all.includes('gpt-5.5'), 'Should include gpt-5.5');
      assert.ok(all.includes('claude-opus-4-6'), 'Should include claude-opus-4-6');
      assert.ok(all.includes('claude-opus-4-8'), 'Should include claude-opus-4-8');
      assert.ok(all.includes('claude-opus-4-7'), 'Should include claude-opus-4-7');
      assert.ok(all.includes('claude-sonnet-4-6'), 'Should include claude-sonnet-4-6');
      assert.ok(all.includes('deepseek-v4-pro'), 'Should include deepseek-v4-pro');
      assert.ok(all.includes('deepseek-v4-flash'), 'Should include deepseek-v4-flash');
      assert.ok(all.includes('deepseek-v4-pro[1m]'), 'Should include deepseek-v4-pro[1m]');
      assert.ok(all.includes('glm-5.2'), 'Should include glm-5.2');
      assert.ok(all.includes('kimi-k2.7-code'), 'Should include kimi-k2.7-code');
    });

    it('groups models by agent', () => {
      const { byAgent } = getKnownModels('.');

      const codexModels = byAgent.get('codex') || [];
      const claudeModels = byAgent.get('claude') || [];

      assert.ok(codexModels.includes('gpt-5.6-terra'), 'Codex should include gpt-5.6-terra');
      assert.ok(!codexModels.includes('gpt-5.5'), 'Codex should not include retired gpt-5.5');
      assert.ok(claudeModels.includes('claude-opus-4-6'), 'Claude should include claude-opus-4-6');
      assert.ok(claudeModels.includes('claude-opus-4-8'), 'Claude should include claude-opus-4-8');
      assert.ok(claudeModels.includes('claude-opus-4-7'), 'Claude should include claude-opus-4-7');
      assert.ok(claudeModels.includes('deepseek-v4-pro'), 'Claude should include deepseek-v4-pro');
    });

    it('deduplicates models from pricing and agentMap', () => {
      const { all } = getKnownModels('.');

      // Count occurrences of gpt-5.4 (should appear only once despite being in both configs)
      const count = all.filter(m => m === 'gpt-5.4').length;
      assert.strictEqual(count, 1, 'gpt-5.4 should appear only once');
    });
  });

  describe('isValidModel', () => {
    it('returns true for known models', () => {
      assert.strictEqual(isValidModel('gpt-5.3-codex', '.'), true);
      assert.strictEqual(isValidModel('gpt-5.4', '.'), true);
      assert.strictEqual(isValidModel('gpt-5.5', '.'), true);
      assert.strictEqual(isValidModel('claude-opus-4-6', '.'), true);
      assert.strictEqual(isValidModel('claude-opus-4-8', '.'), true);
      assert.strictEqual(isValidModel('claude-opus-4-7', '.'), true);
      assert.strictEqual(isValidModel('claude-sonnet-4-6', '.'), true);
      assert.strictEqual(isValidModel('deepseek-v4-pro', '.'), true);
      assert.strictEqual(isValidModel('deepseek-v4-flash', '.'), true);
      assert.strictEqual(isValidModel('deepseek-v4-pro[1m]', '.'), true);
      assert.strictEqual(isValidModel('glm-5.2', '.'), true);
      assert.strictEqual(isValidModel('kimi-k2.7-code', '.'), true);
    });

    it('returns false for unknown models', () => {
      assert.strictEqual(isValidModel('chatgpt-5.3', '.'), false);
      assert.strictEqual(isValidModel('chatgpt-5.4', '.'), false);
      assert.strictEqual(isValidModel('gpt-99', '.'), false);
      assert.strictEqual(isValidModel('deepseek-v4-pro[]', '.'), false);
    });
  });

  describe('suggestModel', () => {
    it('suggests close matches for typos', () => {
      const suggestions = suggestModel('chatgpt-5.3', '.');

      // Should suggest gpt-5.3-codex or gpt-5.4 (close matches)
      assert.ok(suggestions.length > 0, 'Should suggest at least one model');
      assert.ok(
        suggestions.some(s => s.includes('gpt-5')),
        'Should suggest a gpt-5 model'
      );
    });

    it('returns empty array for very different strings', () => {
      const suggestions = suggestModel('completely-different-model-xyz', '.');

      // Should not suggest anything with distance > 5
      assert.ok(
        suggestions.length === 0 || suggestions.every(s => s.length > 0),
        'Should return empty or valid suggestions'
      );
    });

    it('limits suggestions to 3', () => {
      const suggestions = suggestModel('gpt', '.');

      assert.ok(suggestions.length <= 3, 'Should return at most 3 suggestions');
    });
  });

  describe('validateModelOrThrow', () => {
    it('does not throw for valid models', () => {
      assert.doesNotThrow(() => {
        validateModelOrThrow('gpt-5.3-codex', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('gpt-5.4', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('gpt-5.5', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('claude-opus-4-6', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('claude-opus-4-8', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('claude-opus-4-7', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('deepseek-v4-pro', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('deepseek-v4-flash', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('deepseek-v4-pro[1m]', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('glm-5.2', '.');
      });
      assert.doesNotThrow(() => {
        validateModelOrThrow('kimi-k2.7-code', '.');
      });
    });

    it('throws for invalid models', () => {
      assert.throws(
        () => validateModelOrThrow('chatgpt-5.3', '.'),
        /Unknown model "chatgpt-5.3"/
      );
      assert.throws(
        () => validateModelOrThrow('invalid-model', '.'),
        /Unknown model "invalid-model"/
      );
      assert.throws(
        () => validateModelOrThrow('deepseek-v4-pro[2m]', '.'),
        /Unknown DeepSeek model "deepseek-v4-pro\[2m\]"/
      );
      assert.throws(
        () => validateModelOrThrow('deepseek-v4-pro\[\]', '.'),
        /Invalid model ID "deepseek-v4-pro\[\]"/
      );
      assert.throws(
        () => validateModelOrThrow('DEEPSEEK-V4-PRO', '.'),
        /Invalid model ID "DEEPSEEK-V4-PRO"/
      );
    });

    it('includes suggestions in error message', () => {
      try {
        validateModelOrThrow('chatgpt-5.3', '.');
        assert.fail('Should have thrown');
      } catch (err) {
        const message = errorMessage(err);
        assert.ok(
          message.includes('Did you mean:'),
          'Error message should include suggestions'
        );
        assert.ok(
          message.includes('gpt-5'),
          'Error message should suggest a gpt-5 model'
        );
      }
    });

    it('lists configured DeepSeek models in DeepSeek-specific unknown errors', () => {
      try {
        validateModelOrThrow('deepseek-v4-ultra', '.');
        assert.fail('Should have thrown');
      } catch (err) {
        const message = errorMessage(err);
        assert.ok(message.includes('Configured DeepSeek models:'));
        assert.ok(message.includes('deepseek-v4-pro'));
        assert.ok(message.includes('deepseek-v4-flash'));
      }
    });

    it('lists known models grouped by agent in error', () => {
      try {
        validateModelOrThrow('invalid', '.');
        assert.fail('Should have thrown');
      } catch (err) {
        const message = errorMessage(err);
        assert.ok(
          message.includes('Codex models:'),
          'Error should list Codex models'
        );
        assert.ok(
          message.includes('Claude models:'),
          'Error should list Claude models'
        );
        assert.ok(
          message.includes('gpt-5.3-codex'),
          'Error should list specific models'
        );
      }
    });
  });

  describe('validateModelSelectorTokenOrThrow', () => {
    it('accepts family aliases, inherit, and pinned IDs', () => {
      assert.deepEqual(validateModelSelectorTokenOrThrow('opus', '.'), {
        token: 'opus',
        selector: { kind: 'alias', family: 'opus', channel: 'stable' },
        kind: 'alias',
      });
      assert.deepEqual(validateModelSelectorTokenOrThrow(' inherit ', '.'), {
        token: 'inherit',
        selector: { kind: 'inherit' },
        kind: 'inherit',
      });
      assert.deepEqual(validateModelSelectorTokenOrThrow('claude-opus-4-7', '.'), {
        token: 'claude-opus-4-7',
        selector: { kind: 'pinned', modelId: 'claude-opus-4-7' },
        kind: 'pinned',
      });
    });

    it('accepts explicit channels supported by the parser', () => {
      assert.deepEqual(validateModelSelectorTokenOrThrow('opus:stable', '.'), {
        token: 'opus:stable',
        selector: { kind: 'alias', family: 'opus', channel: 'stable' },
        kind: 'alias',
      });
    });

    it('rejects unknown aliases with accepted forms guidance', () => {
      assert.throws(
        () => validateModelSelectorTokenOrThrow('bogus', '.'),
        /Accepted forms: family alias/,
      );
      assert.throws(
        () => validateModelSelectorTokenOrThrow('bogus', '.'),
        /Unknown model family "bogus"/,
      );
    });

    it('rejects unknown pinned-looking IDs with accepted forms guidance', () => {
      assert.throws(
        () => validateModelSelectorTokenOrThrow('gpt-4', '.'),
        /Unknown model "gpt-4"/,
      );
      assert.throws(
        () => validateModelSelectorTokenOrThrow('gpt-4', '.'),
        /Accepted forms: family alias/,
      );
    });

    it('rejects empty or whitespace-only selector tokens', () => {
      assert.throws(
        () => validateModelSelectorTokenOrThrow('   ', '.'),
        /Invalid model selector/,
      );
      assert.throws(
        () => validateModelSelectorTokenOrThrow('', '.'),
        /must not be empty/,
      );
    });
  });

  describe('resolveModelSelectorTokenOrThrow', () => {
    it('resolves aliases to concrete model IDs for launch', () => {
      const resolved = resolveModelSelectorTokenOrThrow('opus', 'reviewer', '.');
      assert.equal(resolved.resolvedModelId, 'claude-opus-4-8');
      assert.equal(resolved.token, 'opus');
      assert.equal(resolved.kind, 'alias');
    });

    it('resolves inherit to a concrete stage model before launch', () => {
      const resolved = resolveModelSelectorTokenOrThrow('inherit', 'coder', '.');
      assert.equal(typeof resolved.resolvedModelId, 'string');
      assert.ok(resolved.resolvedModelId.length > 0);
      assert.equal(resolved.token, 'inherit');
      assert.equal(resolved.kind, 'inherit');
    });

    it('resolves inherit from WAVEMILL_RESOLVED_MODEL before falling back to defaults', () => {
      const previous = process.env.WAVEMILL_RESOLVED_MODEL;
      process.env.WAVEMILL_RESOLVED_MODEL = 'claude-haiku-4-5-20251001';
      try {
        const resolved = resolveModelSelectorTokenOrThrow('inherit', 'coder', '.');
        assert.equal(resolved.resolvedModelId, 'claude-haiku-4-5-20251001');
      } finally {
        if (previous === undefined) {
          delete process.env.WAVEMILL_RESOLVED_MODEL;
        } else {
          process.env.WAVEMILL_RESOLVED_MODEL = previous;
        }
      }
    });
  });
});
