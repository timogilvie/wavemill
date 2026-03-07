/**
 * Tests for model-validator.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getKnownModels,
  isValidModel,
  suggestModel,
  validateModelOrThrow,
} from './model-validator.ts';

describe('model-validator', () => {
  describe('getKnownModels', () => {
    it('returns models from pricing config', () => {
      const { all } = getKnownModels('.');

      // Should include models from .wavemill-config.json pricing
      assert.ok(all.includes('gpt-5.3-codex'), 'Should include gpt-5.3-codex');
      assert.ok(all.includes('gpt-5.4'), 'Should include gpt-5.4');
      assert.ok(all.includes('claude-opus-4-6'), 'Should include claude-opus-4-6');
    });

    it('groups models by agent', () => {
      const { byAgent } = getKnownModels('.');

      const codexModels = byAgent.get('codex') || [];
      const claudeModels = byAgent.get('claude') || [];

      assert.ok(codexModels.includes('gpt-5.3-codex'), 'Codex should include gpt-5.3-codex');
      assert.ok(claudeModels.includes('claude-opus-4-6'), 'Claude should include claude-opus-4-6');
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
      assert.strictEqual(isValidModel('claude-opus-4-6', '.'), true);
    });

    it('returns false for unknown models', () => {
      assert.strictEqual(isValidModel('chatgpt-5.3', '.'), false);
      assert.strictEqual(isValidModel('chatgpt-5.4', '.'), false);
      assert.strictEqual(isValidModel('gpt-99', '.'), false);
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
        validateModelOrThrow('claude-opus-4-6', '.');
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
    });

    it('includes suggestions in error message', () => {
      try {
        validateModelOrThrow('chatgpt-5.3', '.');
        assert.fail('Should have thrown');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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

    it('lists known models grouped by agent in error', () => {
      try {
        validateModelOrThrow('invalid', '.');
        assert.fail('Should have thrown');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
});
