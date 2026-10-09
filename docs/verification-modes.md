# Verification Modes

**Status:** Implemented (HOK-1346)

## Overview

Wavemill's verification system automatically enforces extra checks when weaker models generate code, making fallback feel like controlled degradation rather than regression.

**Key principle:** Strong models operate normally. Weak models get extra safeguards.

## When Verification Activates

Verification is triggered automatically when:

1. **Model quality < threshold** - The coder model's quality score falls below the threshold for the task type
   - Default coding threshold: 80
   - Haiku (score: 60) triggers verification
   - Sonnet (score: 90) and Opus (score: 85) do not

2. **Automatic fallback** - When quota limits force fallback to a weaker model, verification activates transparently

## Verification Modes

### Mode 1: Strong Model (Normal Operation)

**When:** Coder model score >= threshold

**Behavior:**
- No extra verification
- Standard workflow proceeds
- No performance overhead

**Example:** Sonnet or Opus coding a moderate task

```
✓ Strong model (claude-sonnet-5) - no extra verification needed
```

### Mode 2: Weak Model + Strong Reviewer Available

**When:** 
- Coder model score < threshold
- Stronger reviewer model available (reviewer score > coder score)
- Changes include risky code patterns

**Behavior:**
1. **Mandatory checks** run before commit:
   - Typecheck (if configured)
   - Lint (if configured)
   - Tests (if configured)
   - Self-explanation in commit message

2. **Second-pass review** by stronger model:
   - First pass: General review by primary reviewer
   - Second pass: Risk-focused review by strongest available model
   - Focuses on: auth, migrations, crypto, permissions

**Example:** Haiku coding with Opus available for review

```
⚠️  Weak model detected: claude-haiku-4-5-20251001 (score: 60, threshold: 80)
Quality gap: 20 points below threshold

Running typecheck: npm run typecheck
✓ typecheck passed

Running lint: npm run lint
✓ lint passed

Running test: npm test
✓ test passed

✓ All verification checks passed

Second-pass review will be required (stronger reviewer available: claude-opus-4-8)
```

### Mode 3: Weak Model + No Strong Reviewer (Degraded Mode)

**When:**
- Coder model score < threshold
- No stronger reviewer available
- All available models at or below coder quality

**Behavior:**
1. **Mandatory checks** run before commit (same as Mode 2)

2. **Patch size cap** enforced:
   - Cap calculated based on quality gap
   - Formula: `cap = 200 * max(0.5, 1 - (gap / 50))`
   - Changes exceeding cap are rejected
   - Clear guidance to split work into smaller PRs

**Example:** Haiku coding with no stronger models available

```
⚠️  Weak model detected: claude-haiku-4-5-20251001 (score: 60, threshold: 80)
Quality gap: 20 points below threshold

Running typecheck: npm run typecheck
✓ typecheck passed

Running lint: npm run lint
✓ lint passed

Running test: npm test
✓ test passed

✓ Patch size 95 lines (under cap of 120)

✓ All verification checks passed
```

**If patch too large:**

```
✗ Patch size cap exceeded:
  Total lines changed: 180
  Cap: 120 lines
  Reason: No stronger reviewer available and coder quality 20 points below threshold

  Suggestion: Split this work into smaller PRs
```

## Configuration

Add to `.wavemill-config.json`:

```json
{
  "verification": {
    "enabled": true,
    "qualityThresholds": {
      "coding": 80,
      "review": 80
    },
    "patchSizeCap": {
      "baseLines": 200,
      "adjustByQualityGap": true
    },
    "mandatoryChecks": {
      "typecheck": true,
      "lint": true,
      "test": true,
      "selfExplanation": true
    },
    "secondPassReview": {
      "enabled": true,
      "riskPatterns": [
        "**/auth/**",
        "**/migrations/**",
        "**/*crypto*",
        "**/*permission*"
      ]
    }
  }
}
```

All fields are optional. Defaults match the examples above.

## Check Commands

Verification uses check commands from `claude/config.json`:

```json
{
  "checks": {
    "typecheck": "npm run typecheck",
    "lint": "npm run lint",
    "test": "npm test"
  }
}
```

If a check command is not configured, that check is skipped gracefully.

## Quality Thresholds

Default thresholds by task type:

| Task Type | Threshold | Strong Models | Weak Models |
|-----------|-----------|---------------|-------------|
| **coding** | **80** | **Sonnet (90), Opus (85)** | **Haiku (60)** |
| review | 80 | Opus (95), Sonnet (82) | Haiku (55) |
| planning | 70 | Opus (95), Sonnet (82) | Haiku (55) |

### Adjusting Thresholds

To make verification more/less sensitive:

```json
{
  "verification": {
    "qualityThresholds": {
      "coding": 75  // Lower threshold = more models trigger verification
    }
  }
}
```

**Recommendation:** Keep defaults unless you have specific evidence that they're wrong. Thresholds are calibrated to cleanly separate Haiku from Sonnet+.

## Patch Size Caps

### Default Formula

```
multiplier = max(0.5, 1 - (quality_gap / 50))
cap = base_lines * multiplier
```

### Examples

| Coder Score | Quality Gap | Multiplier | Cap (lines) |
|-------------|-------------|------------|-------------|
| 60 (Haiku) | 20 | 0.6 | 120 |
| 50 (hypothetical) | 30 | 0.4 | 100 (floored) |
| 40 (hypothetical) | 40 | 0.2 | 100 (floored) |

### Adjusting Caps

To change the base cap:

```json
{
  "verification": {
    "patchSizeCap": {
      "baseLines": 300,  // Increase base cap
      "adjustByQualityGap": true
    }
  }
}
```

To use a fixed cap (no adjustment):

```json
{
  "verification": {
    "patchSizeCap": {
      "baseLines": 150,
      "adjustByQualityGap": false  // Fixed 150-line cap
    }
  }
}
```

## Second-Pass Review

### Risk Patterns

Second-pass review focuses on high-risk code areas:

- Authentication/authorization (`**/auth/**`)
- Database migrations (`**/migrations/**`, `**/schema/**`)
- Cryptography (`**/*crypto*`, `**/*encryption*`)
- Permissions (`**/*permission*`)
- Security (`**/*security*`)

### Customizing Risk Patterns

```json
{
  "verification": {
    "secondPassReview": {
      "enabled": true,
      "riskPatterns": [
        "**/payments/**",      // Add custom patterns
        "**/billing/**",
        "**/*sensitive*"
      ]
    }
  }
}
```

### Disabling Second-Pass Review

```json
{
  "verification": {
    "secondPassReview": {
      "enabled": false  // Always use patch size cap instead
    }
  }
}
```

**Not recommended** - second-pass review is safer than patch size caps when stronger models are available.

## Manual Verification

To run verification manually:

```bash
# Set up routing metadata
export WAVEMILL_CODER_MODEL=claude-haiku-4-5-20251001
export WAVEMILL_AVAILABLE_REVIEWERS=claude-opus-4-8,claude-sonnet-5
export WAVEMILL_MILLED_REPO_DIR=/path/to/repo

# Run verification
npx tsx shared/lib/run-verification.ts
```

Or rely on routing metadata file:

```bash
# Assumes /tmp/{session}-{issue}-route.json exists
export WAVEMILL_SESSION=my-session
export WAVEMILL_ISSUE=HOK-123

npx tsx shared/lib/run-verification.ts
```

## Emergency Escape Hatch

If verification blocks valid code in an emergency:

```bash
SKIP_VERIFICATION=true npx tsx shared/lib/run-verification.ts
```

**Use sparingly** - this bypasses all safety checks. Monitor usage via audit logs.

## Troubleshooting

### Verification Always Skipped

**Symptom:** No verification runs even with weak model

**Check:**
1. Is routing metadata available? `ls /tmp/$SESSION-$ISSUE-route.json`
2. Does the routing JSON have a `coder` field? `jq '.coder' /tmp/$SESSION-$ISSUE-route.json`
3. Is verification enabled in config? `jq '.verification.enabled' .wavemill-config.json`

### False Positive Rejections

**Symptom:** Valid code rejected by patch size cap

**Solutions:**
1. Split work into smaller PRs (recommended)
2. Increase base cap in config (if genuinely needed)
3. Use stronger reviewer to avoid patch size cap

### Second-Pass Review Never Triggers

**Symptom:** Expected second-pass review but didn't happen

**Check:**
1. Are stronger reviewers available? Verify router config includes Opus/Sonnet for review stage
2. Do changes include risky code? Second-pass only triggers for auth/crypto/migrations/permissions
3. Is second-pass enabled in config? `jq '.verification.secondPassReview.enabled' .wavemill-config.json`

### Check Commands Failing

**Symptom:** Typecheck/lint/test always fail

**Check:**
1. Do the commands work standalone? Run `npm run typecheck` manually
2. Are commands configured correctly in `claude/config.json`?
3. Is the working directory correct for the commands?

## Performance Impact

| Mode | Overhead | When It Occurs |
|------|----------|----------------|
| Strong Model | None | ~90% of tasks |
| Weak Model + Checks | 30-60s | ~10% of tasks |
| Weak Model + Second-Pass | +2-5min | ~2% of tasks (risky code only) |

**Net impact:** Minimal for typical workloads, since verification only activates for weak models.

## Metrics & Monitoring

Verification metadata is logged to eval records:

```json
{
  "verificationMetadata": {
    "coderModel": "claude-haiku-4-5-20251001",
    "coderScore": 60,
    "threshold": 80,
    "qualityGap": 20,
    "verificationNeeded": true,
    "secondPassTriggered": true,
    "patchSizeEnforced": false
  }
}
```

Use this data to:
- Track false positive rate (verification blocked valid code)
- Identify threshold tuning opportunities
- Measure performance impact
- Train GEPA on verification decisions

## Best Practices

1. **Trust the defaults** - Thresholds are calibrated based on model capabilities
2. **Monitor false positives** - If verification frequently blocks valid code, file an issue
3. **Split large PRs** - Even with strong models, smaller PRs are easier to review
4. **Configure check commands** - Verification is most effective when typecheck/lint/test are configured
5. **Use stronger reviewers when available** - Second-pass review is safer than patch size caps

## Related Documentation

- [Model Registry](../shared/lib/model-registry.ts) - Quality scores and capabilities
- [Stage-Aware Router](../shared/lib/stage-aware-router.ts) - Model selection logic
- [Review Engine](../shared/lib/review-engine.ts) - Code review implementation
- [Subsystem Spec](./.wavemill/context/verification.md) - Technical details
