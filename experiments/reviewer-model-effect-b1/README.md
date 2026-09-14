# Reviewer Model Effect B1

Reproduces the HOK-2073 Phase 1 observational go/no-go analysis.

```bash
pip install -r experiments/reviewer-model-effect-b1/requirements.txt
python3 experiments/reviewer-model-effect-b1/analyze.py
pytest experiments/reviewer-model-effect-b1/tests
```

By default, `analyze.py` looks for the eval corpus at:

1. `.wavemill/evals/evals.jsonl` under the current checkout.
2. An ancestor checkout's `.wavemill/evals/evals.jsonl` (useful from worktrees).

Pass `--input /path/to/evals.jsonl` to override the source.
