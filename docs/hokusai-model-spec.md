# Hokusai Model Specification  
## Model Name: Wavemill Workflow Router

---

## 1. Overview

The **Wavemill Workflow Router** predicts the optimal configuration of AI agents to complete a technical task successfully within a defined cost constraint.

Given a structured description of a task and a maximum budget, the model selects:
- planner model
- coder model
- reviewer model
- execution depth parameters

The model is trained on historical task execution data from Wavemill, where workflows are evaluated based on real outcomes including completion success, cost, time, and intervention.

---

## 2. Objective

The primary objective of the model is:

**Maximize task completion success rate while remaining within a specified cost constraint**

---

## 3. Benchmark Definition

Scorer ID:
`hokusai.scorers.wavemill.success_rate_under_budget:v1`

### 3.1 Benchmark Task

Each benchmark sample consists of:
- a structured task descriptor
- a set of available models
- a maximum cost constraint

The model must output a workflow configuration that is expected to complete the task successfully within the cost limit.

---

### 3.2 Evaluation Criteria

#### Stage 1 — Scoreability
A benchmark row is scoreable if:
- the route artifact is valid JSON with planner, coder, and reviewer fields
- the selected measurement policy has enough task input to replay or reroute
- the observed eval row provides completion and budget/cost data

Malformed route artifacts are not dropped. They are counted as `invalid_route` diagnostics.

#### Stage 2 — Feasibility
A prediction is feasible if:
- selected models are allowed
- observed cost ≤ max cost

Else score = 0.

#### Stage 3 — Outcome Score

Score = Successful Completion Under Budget

HEM field:
`workflow_success_rate_under_budget`

Benchmark Score = SuccessfulRunsWithinBudget / ScoreableRuns

---

### 3.3 Definition of Success

completed_successfully == true

---

### 3.4 Budget Compliance

actual_cost_usd ≤ max_cost_usd

Every eval record states where its budget came from (HOK-3390, eval schema
1.59.0): `constraints.budgetSource` and `taskDescriptor.constraints.budget_source`
are one of `request` (explicit caller / router request `max_cost_usd`),
`issue-override` (reserved), `repo-config` (`mill.defaultMaxCostUsd` or
`budget.<mode>` in `.wavemill-config.json`), or `default` (Wavemill's built-in
25/15/5). The router corpus collector passes it through as the `budget_source`
CSV column and treats `default` (and records without a source) as a missing
budget, so budget compliance is only scored against real constraints.

### 3.5 Measurement Policies

- `replay_exact_match`: use the persisted route decision exactly as captured in the route artifact and score it against the observed eval outcome.
- `challenge_prospective`: reconstruct the persisted task input, reroute under the current router with the requested `modelsAvailable`, and score the prospective route against the same observed eval outcome.

### 3.6 Diagnostics

The scorer also emits `wavemill_router_diagnostics` with:
- `scoreable_coverage`
- `invalid_route_rate`
- `budget_compliance_rate`
- `completion_success_rate`
- `total_cost_usd`
- `timing_p50_ms`
- `timing_p95_ms`
- `intervention_rate`
- `intervention_count`
- `total_records`
- `scoreable_records`
- `invalid_route_records`

Mint eligibility may be blocked when `scoreable_coverage` falls below the configured threshold. The default helper threshold is `0.8`, with a default maximum invalid route rate of `0.2`.

---

## 4. Live Prediction Input Schema

```json
{
  "inputs": {
    "task": {
      "description": "string",
      "task_type": "feature|bugfix|refactor|research|maintenance"
    },
    "routing": {
      "available_models": ["string"],
      "available_planner_models": ["string"],
      "available_coder_models": ["string"],
      "available_reviewer_models": ["string"],
      "max_cost_usd": 2.5,
      "objective": "lowest_cost|fastest_completion|highest_reliability"
    },
    "context": {
      "domain": "backend|frontend|fullstack|devops|data|ml|mobile",
      "repo_size_bucket": "small|medium|large|xlarge",
      "requires_tests": true,
      "risk_level": "low|medium|high",
      "file_count": 8,
      "estimated_complexity": "low|medium|high",
      "security_sensitive": false
    },
    "workflow": {
      "stages": ["plan", "code", "review"]
    },
    "metadata": {
      "external_task_id": "HOK-1246",
      "run_id": "string",
      "integration_version": "string",
      "idempotency_key": "string"
    }
  }
}
```

---

## 5. Live Prediction Output Schema

```json
{
  "predictions": {
    "recommended_strategy": {
      "planner_model": "string",
      "coder_model": "string",
      "reviewer_model": "string",
      "stages": ["plan", "code", "review"],
      "estimated_success_under_budget": 0.0,
      "estimated_cost_usd": 0.0,
      "estimated_duration_seconds": 0,
      "confidence": 0.0
    },
    "alternatives": [],
    "tradeoffs": [],
    "nearest_neighbors": []
  },
  "metadata": {
    "request_id": "string",
    "inference_log_id": "string"
  }
}
```

The documented production prediction endpoint is:

`POST https://api.hokus.ai/api/v1/models/30/predict`

---

## 6. Contribution / Outcome Schema

```json
{
  "success_under_budget": true,
  "task_id": "string",
  "actual_cost_usd": 2.41,
  "wall_clock_seconds": 1840,
  "harness": "wavemill",
  "inputs": {
    "task_type": "bugfix",
    "routing": {
      "max_cost_usd": 3.0
    }
  }
}
```

Wavemill can also emit stricter benchmark contribution rows under `technical_task_router_row/v1` for benchmark-style observations. The local row validator remains compatible with legacy `technical_task_router.success_under_budget/v1` rows, while the Hokusai audit command layers additive conformance checks for cross-repo benchmark exports and the target `technical_task_router.benchmark_score/v2` policy.

Contribution uploads are asynchronous outcome data. They are not the same payload as the live `/predict` request, and Wavemill does not assume an immediate token receipt for every accepted row.

---

## 7. DeltaOne Definition

**1 DeltaOne = 1 percentage point improvement in success rate under budget**

DeltaOne = BenchmarkScore_new − BenchmarkScore_baseline

---

## 8. Summary

This model predicts workflow configurations that maximize successful task completion within budget using real execution data. Reward logic remains tied to predefined DeltaOne improvement, while benchmark exports are transitioning toward `technical_task_router.benchmark_score/v2`, a bounded composite over success-under-budget plus additional robustness checks surfaced by `wavemill hokusai audit`.
