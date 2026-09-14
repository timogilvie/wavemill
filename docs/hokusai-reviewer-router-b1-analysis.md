# Hokusai reviewer-router B1 analysis

Generated from `/Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/evals.jsonl` on 2026-09-14T13:29:08.656389+00:00.

## Recommendation

Recommendation: No-Go

No reviewer contrast clears the precommitted effect-size, confidence-interval, and sensitivity gates on the current observational corpus.

## Corpus

- Total eval records scanned: 1956
- Logged reviewer rows used after normalization and complete-case filtering: 443
- Primary reviewer threshold: n >= 30
- Primary reviewers: gpt-5.5, claude-opus-4-7, claude-haiku-4-5-20251001
- Baseline reviewer: claude-opus-4-7
- Latest-three schema sensitivity cohort: 1.45.0, 1.46.0, 1.47.0
- Reviewer normalization counts: `{"alias": 1, "canonical": 442, "missing": 1513, "unresolvable": 0}`

## Descriptives

| Reviewer | n | Mean score | Mean complexity | Mean workflow cost | Intervention rate | Success rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gpt-5.5 | 167 | 0.767 | 4.06 | $11.93 | 52.1% | 55.7% |
| claude-opus-4-7 | 150 | 0.768 | 3.97 | $16.48 | 59.3% | 59.3% |
| claude-haiku-4-5-20251001 | 94 | 0.750 | 4.18 | $8.96 | 62.8% | 54.3% |
| gpt-5.4 | 10 | 0.771 | 3.80 | $17.26 | 60.0% | 50.0% |
| gpt-5.6-terra | 7 | 0.816 | 2.57 | $7.65 | 28.6% | 71.4% |
| claude-opus-4-8 | 5 | 0.882 | 3.80 | $38.76 | 40.0% | 80.0% |
| claude-opus-4-6 | 2 | 0.900 | 4.00 | $14.60 | 0.0% | 100.0% |
| claude-fable-5 | 1 | 0.650 | 5.00 | $13.06 | 100.0% | 0.0% |
| claude-sonnet-4-6 | 1 | 0.950 | 4.00 | $19.76 | 0.0% | 100.0% |
| claude-sonnet-5 | 1 | 0.920 | 5.00 | $0.00 | 0.0% | 100.0% |
| gemini-2.5-pro | 1 | 0.600 | 5.00 | $13.87 | 100.0% | 0.0% |
| glm-5.2 | 1 | 0.910 | 4.00 | $10.14 | 0.0% | 100.0% |
| glm-5.3 | 1 | 0.580 | 5.00 | $17.88 | 100.0% | 0.0% |
| kimi-k2.7-code | 1 | 0.620 | 4.00 | $17.88 | 100.0% | 0.0% |
| qwen-3-coder | 1 | 0.550 | 3.00 | $14.76 | 100.0% | 0.0% |

## Method

The primary model is an observational regression over rows with logged reviewer model, complete score/cost/complexity fields, and local reviewer-name normalization. The specification is `outcome ~ reviewer + complexity + task_type + domain`; OLS outcomes use HC1 robust standard errors. Binary intervention is reported as a linear-probability effect for percentage-point interpretation, with a logistic fit retained in `summary.json` as a sanity check. Cost uses `workflowCost` as the downstream workflow-cost outcome and also reports `estimatedCost` in the machine-readable artifact.

Sensitivity checks rerun the same contrast under the latest-three schema cohort, `trainingEligible=True`, and an alternate `gpt-5.5` baseline. The placebo regresses prompt diagnostic bytes on reviewer choice with the same controls; reviewer choice should not causally change the input prompt size, so non-zero placebo contrasts are treated as confounding evidence.

## Primary estimates

Contrasts are adjusted differences versus `claude-opus-4-7`. Score/cost/intervention CIs are 95%.

| Reviewer | Score delta | 95% CI | Cost delta | 95% CI | Intervention delta | 95% CI | Placebo bytes delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gpt-5.5 | -0.001 | [-0.039, 0.037] | $-2.34 | [$-6.09, $1.42] | -6.9% | [-17.8%, 4.1%] | -3889 [-23829, 16051] |
| claude-haiku-4-5-20251001 | -0.020 | [-0.066, 0.026] | $-4.77 | [$-8.46, $-1.07] | 6.0% | [-7.4%, 19.4%] | -13561 [-43092, 15969] |

## Sensitivity and checks

| Reviewer | Outcome | Latest schemas | Training eligible | gpt-5.5 baseline | Direction survives |
| --- | --- | ---: | ---: | ---: | --- |
| gpt-5.5 | score | -0.092 | -0.002 | -0.001 | True |
| gpt-5.5 | intervention_rate | 0.368 | -0.074 | -0.069 | False |
| gpt-5.5 | cost | 0.574 | -2.498 | -2.338 | False |
| claude-haiku-4-5-20251001 | score | -0.030 | -0.020 | -0.020 | True |
| claude-haiku-4-5-20251001 | intervention_rate | 0.236 | 0.054 | 0.060 | True |
| claude-haiku-4-5-20251001 | cost | 0.805 | -5.484 | -4.767 | False |

Cluster bootstrap score intervals by `issueId`:

| Reviewer | 95% bootstrap CI |
| --- | ---: |
| gpt-5.5 | [-0.041, 0.040] |
| claude-haiku-4-5-20251001 | [-0.066, 0.028] |

IPW mean differences are included in `summary.json` as a doubly-robust direction check.

## Challenge appendix

Challenge records vary coder/challenger assignment rather than reviewer assignment, so they are descriptive only and are not used for the reviewer-effect estimate.

- Reviewer-logged eval rows with a `challengePairId`: 319
- Sibling `challenge-records.jsonl` rows scanned: 268
- Challenge-record primary model counts: `{"claude-fable-5": 20, "claude-haiku-4-5-20251001": 5, "claude-opus-4-7": 1, "claude-sonnet-4-5-20250929": 9, "claude-sonnet-4-6": 25, "claude-sonnet-5": 1, "gpt-5.3-codex": 8, "gpt-5.4": 99, "gpt-5.5": 94, "gpt-5.6-terra": 1, "unknown": 5}`
- Challenge-record challenger model counts: `{"claude-fable-5": 2, "claude-haiku-4-5": 4, "claude-haiku-4-5-20251001": 21, "claude-opus-4-6": 21, "claude-opus-4-7": 10, "claude-opus-4-8": 1, "claude-sonnet-4-5-20250929": 13, "claude-sonnet-4-6": 31, "devstral-small": 1, "gemini-2.5-flash": 2, "gemini-2.5-pro": 6, "glm-5.2": 6, "glm-5.3-flash": 1, "gpt-5.3-codex": 15, "gpt-5.4": 29, "gpt-5.5": 45, "gpt-5.6-terra": 3, "kimi-k2": 1, "kimi-k2-thinking": 1, "kimi-k2.7-code": 7, "llama-3.3-70b": 1, "llama-4-scout": 2, "mistral-medium-3": 1, "qwen-2.5-coder-32b": 3, "qwen-3-235b": 1, "qwen-3-coder": 6, "unknown": 34}`

## Limitations

- This is observational, not randomized. Complexity, task type, and domain reduce visible confounding but cannot remove unobserved routing policy differences.
- Fine-signature cells are sparse; the regression carries more of the estimate than the within-cell contrast table.
- The prompt-size placebo shows how much reviewer assignment remains entangled with task shape after controls.
- Approximate detectable score delta at 95% confidence in the current corpus: 0.038.
