from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from data_prep import (
    MIN_PRIMARY_REVIEWER_N,
    latest_schema_versions,
    load_evals,
    primary_reviewers,
    reviewer_counts,
    with_reviewer_bucket,
)
from stats import cluster_bootstrap_ci, logistic_regression, multinomial_propensity, ols_hc1, wilson_ci


BASELINE_REVIEWER = "claude-opus-4-7"
ALT_BASELINE_REVIEWER = "gpt-5.5"
OUTCOME_SPECS = {
    "score": {"column": "score", "kind": "ols"},
    "cost": {"column": "workflow_cost_winsorized", "kind": "ols"},
    "estimated_cost": {"column": "estimated_cost_winsorized", "kind": "ols"},
    "reviewer_score": {"column": "reviewer_score", "kind": "ols"},
    "intervention_rate": {"column": "intervention_required_int", "kind": "ols"},
    "intervention_logit": {"column": "intervention_required_int", "kind": "logit"},
    "success_logit": {"column": "success_int", "kind": "logit"},
    "placebo_prompt_bytes": {"column": "prompt_total_bytes", "kind": "ols"},
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Estimate reviewer-model effects for HOK-2073.")
    parser.add_argument("--input", type=Path, default=None, help="Path to evals.jsonl")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "output")
    parser.add_argument("--report", type=Path, default=Path(__file__).parents[1].parents[0] / "docs" / "hokusai-reviewer-router-b1-analysis.md")
    parser.add_argument("--bootstrap-iterations", type=int, default=1000)
    args = parser.parse_args()

    frame, metadata = load_evals(args.input)
    if frame.empty:
        raise SystemExit("No reviewer-model rows found after normalization.")

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "figures").mkdir(exist_ok=True)

    analysis_frame = prepare_analysis_frame(frame)
    counts = reviewer_counts(analysis_frame)
    primary = primary_reviewers(analysis_frame)
    if BASELINE_REVIEWER not in primary:
        raise SystemExit(f"Baseline reviewer {BASELINE_REVIEWER!r} is not present with n >= {MIN_PRIMARY_REVIEWER_N}.")

    per_stratum = build_per_stratum(analysis_frame)
    per_stratum.to_csv(output_dir / "per_stratum.csv", index=False)

    primary_fit = fit_suite(analysis_frame, primary, BASELINE_REVIEWER)
    latest_versions = latest_schema_versions(analysis_frame, 3)
    sensitivities = {
        "latest_three_schema_versions": fit_suite(
            analysis_frame[analysis_frame["schema_version"].isin(latest_versions)],
            primary,
            BASELINE_REVIEWER,
        ),
        "training_eligible": fit_suite(
            analysis_frame[analysis_frame["training_eligible"]],
            primary,
            BASELINE_REVIEWER,
        ),
        "gpt_5_5_baseline": fit_suite(analysis_frame, primary, ALT_BASELINE_REVIEWER),
    }

    ipw = ipw_mean_differences(analysis_frame, primary, BASELINE_REVIEWER)
    stratified = stratified_contrasts(analysis_frame, primary, BASELINE_REVIEWER)
    bootstrap = score_cluster_bootstrap(analysis_frame, primary, BASELINE_REVIEWER, args.bootstrap_iterations)
    recommendation = evaluate_go_no_go(primary_fit, sensitivities, analysis_frame, primary)

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "analysis": "HOK-2073 reviewer-model effect B1",
        "baseline_reviewer": BASELINE_REVIEWER,
        "alternate_baseline": ALT_BASELINE_REVIEWER,
        "min_primary_reviewer_n": MIN_PRIMARY_REVIEWER_N,
        "data": {
            **metadata,
            "used_rows": int(len(analysis_frame)),
            "reviewer_counts": counts,
            "primary_reviewers": primary,
            "latest_three_schema_versions": latest_versions,
            "normalization_drop_rate_among_review_candidates": normalization_drop_rate(metadata),
        },
        "descriptives": descriptive_block(analysis_frame),
        "challenge_appendix": challenge_appendix(analysis_frame, Path(metadata["source"])),
        "primary_estimates": primary_fit,
        "stratified_contrasts": stratified,
        "ipw_mean_differences": ipw,
        "cluster_bootstrap_score_ci": bootstrap,
        "sensitivities": sensitivities,
        "go_no_go": recommendation,
    }

    with (output_dir / "summary.json").open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2, sort_keys=True)
        handle.write("\n")

    write_report(args.report, summary)
    print(f"Wrote {output_dir / 'summary.json'}")
    print(f"Wrote {output_dir / 'per_stratum.csv'}")
    print(f"Wrote {args.report}")


def prepare_analysis_frame(frame: pd.DataFrame) -> pd.DataFrame:
    copy = frame.copy()
    copy = copy.dropna(subset=["score", "workflow_cost", "estimated_cost", "complexity"])
    copy["intervention_required_int"] = copy["intervention_required"].astype(int)
    copy["success_int"] = copy["success"].astype(int)
    for column in ["workflow_cost", "estimated_cost"]:
        low, high = copy[column].quantile([0.01, 0.99])
        copy[f"{column}_winsorized"] = copy[column].clip(lower=low, upper=high)
    return copy


def build_design(frame: pd.DataFrame, primary: list[str], baseline: str) -> tuple[np.ndarray, list[str], pd.DataFrame]:
    bucketed = with_reviewer_bucket(frame, primary)
    categories = {
        "reviewer_bucket": [baseline] + [model for model in primary if model != baseline] + ["other_lt30"],
        "task_type": sorted(bucketed["task_type"].dropna().astype(str).unique()),
        "domain": sorted(bucketed["domain"].dropna().astype(str).unique()),
    }
    columns = [np.ones(len(bucketed))]
    names = ["Intercept"]

    for model in categories["reviewer_bucket"]:
        if model == baseline:
            continue
        names.append(f"reviewer:{model}")
        columns.append((bucketed["reviewer_bucket"] == model).astype(float).to_numpy())

    names.append("complexity")
    columns.append(bucketed["complexity"].astype(float).to_numpy())

    for field in ["task_type", "domain"]:
        levels = categories[field]
        for level in levels[1:]:
            names.append(f"{field}:{level}")
            columns.append((bucketed[field].astype(str) == level).astype(float).to_numpy())

    return np.column_stack(columns), names, bucketed


def fit_suite(frame: pd.DataFrame, primary: list[str], baseline: str) -> dict[str, Any]:
    usable_primary = [model for model in primary if model in set(frame["reviewer_model"])]
    if baseline not in usable_primary:
        return {"available": False, "reason": f"baseline {baseline} absent", "n": int(len(frame))}

    x, names, bucketed = build_design(frame, usable_primary, baseline)
    result: dict[str, Any] = {"available": True, "n": int(len(bucketed)), "baseline": baseline, "contrasts": {}}
    for outcome_name, spec in OUTCOME_SPECS.items():
        column = spec["column"]
        subset_mask = bucketed[column].notna().to_numpy()
        if subset_mask.sum() <= len(names):
            result["contrasts"][outcome_name] = {"available": False, "reason": "insufficient rows"}
            continue
        y = bucketed.loc[subset_mask, column].astype(float).to_numpy()
        x_subset = x[subset_mask]
        try:
            fit = logistic_regression(y, x_subset, names) if spec["kind"] == "logit" else ols_hc1(y, x_subset, names)
        except Exception as exc:
            result["contrasts"][outcome_name] = {"available": False, "reason": str(exc)}
            continue
        result["contrasts"][outcome_name] = {
            "available": True,
            "kind": spec["kind"],
            "n": int(len(y)),
            "terms": fit.as_dict(),
            "reviewer_effects": reviewer_effects_from_fit(fit, usable_primary, baseline),
        }
    return result


def reviewer_effects_from_fit(fit: Any, primary: list[str], baseline: str) -> dict[str, dict[str, float]]:
    terms = fit.as_dict()
    effects: dict[str, dict[str, float]] = {}
    for model in primary:
        if model == baseline:
            effects[model] = {"estimate": 0.0, "se": 0.0, "ci_low": 0.0, "ci_high": 0.0, "p_value": 1.0}
        else:
            effects[model] = terms.get(f"reviewer:{model}", {"estimate": 0.0, "se": 0.0, "ci_low": 0.0, "ci_high": 0.0, "p_value": 1.0})
    return effects


def contrast_between_models(fit_suite_result: dict[str, Any], outcome: str, target: str, reference: str) -> dict[str, float] | None:
    if not fit_suite_result.get("available"):
        return None
    block = fit_suite_result.get("contrasts", {}).get(outcome, {})
    if not block.get("available"):
        return None
    terms = block["terms"]
    baseline = fit_suite_result["baseline"]

    def term(model: str) -> dict[str, float]:
        if model == baseline:
            return {"estimate": 0.0, "se": 0.0}
        return terms.get(f"reviewer:{model}", {"estimate": 0.0, "se": 0.0})

    target_term = term(target)
    reference_term = term(reference)
    estimate = target_term["estimate"] - reference_term["estimate"]
    se = float(np.sqrt(target_term["se"] ** 2 + reference_term["se"] ** 2))
    return {
        "estimate": float(estimate),
        "se": se,
        "ci_low": float(estimate - 1.96 * se),
        "ci_high": float(estimate + 1.96 * se),
    }


def descriptive_block(frame: pd.DataFrame) -> dict[str, Any]:
    rows = {}
    for reviewer, group in frame.groupby("reviewer_model"):
        success_count = int(group["success_int"].sum())
        intervention_count = int(group["intervention_required_int"].sum())
        success_ci = wilson_ci(success_count, len(group))
        intervention_ci = wilson_ci(intervention_count, len(group))
        rows[str(reviewer)] = {
            "n": int(len(group)),
            "mean_score": float(group["score"].mean()),
            "mean_complexity": float(group["complexity"].mean()),
            "mean_workflow_cost": float(group["workflow_cost"].mean()),
            "mean_estimated_cost": float(group["estimated_cost"].mean()),
            "intervention_rate": float(group["intervention_required_int"].mean()),
            "intervention_rate_ci": list(intervention_ci),
            "success_rate": float(group["success_int"].mean()),
            "success_rate_ci": list(success_ci),
        }
    return rows


def build_per_stratum(frame: pd.DataFrame) -> pd.DataFrame:
    grouped = (
        frame.groupby(["fine_signature", "stratum", "task_type", "complexity", "domain", "reviewer_model"], dropna=False)
        .agg(
            n=("score", "size"),
            mean_score=("score", "mean"),
            mean_workflow_cost=("workflow_cost", "mean"),
            mean_estimated_cost=("estimated_cost", "mean"),
            intervention_rate=("intervention_required_int", "mean"),
            success_rate=("success_int", "mean"),
            mean_reviewer_score=("reviewer_score", "mean"),
        )
        .reset_index()
    )
    return grouped.sort_values(["fine_signature", "reviewer_model"])


def stratified_contrasts(frame: pd.DataFrame, primary: list[str], baseline: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for outcome, column in {"score": "score", "cost": "workflow_cost", "intervention_rate": "intervention_required_int"}.items():
        result[outcome] = {}
        for target in primary:
            if target == baseline:
                continue
            cell_effects = []
            for _, cell in frame.groupby("fine_signature"):
                base = cell[cell["reviewer_model"] == baseline][column].dropna().astype(float)
                treat = cell[cell["reviewer_model"] == target][column].dropna().astype(float)
                if len(base) < 5 or len(treat) < 5:
                    continue
                variance = base.var(ddof=1) / len(base) + treat.var(ddof=1) / len(treat)
                if not np.isfinite(variance) or variance <= 0:
                    variance = 1e-9
                cell_effects.append((float(treat.mean() - base.mean()), float(variance), int(len(base)), int(len(treat))))
            if not cell_effects:
                result[outcome][target] = {"available": False, "reason": "no eligible mixed fine-signature cells"}
                continue
            weights = np.array([1 / item[1] for item in cell_effects])
            estimates = np.array([item[0] for item in cell_effects])
            estimate = float(np.sum(weights * estimates) / np.sum(weights))
            se = float(np.sqrt(1 / np.sum(weights)))
            result[outcome][target] = {
                "available": True,
                "estimate": estimate,
                "se": se,
                "ci_low": estimate - 1.96 * se,
                "ci_high": estimate + 1.96 * se,
                "eligible_cells": len(cell_effects),
                "baseline_n_in_cells": int(sum(item[2] for item in cell_effects)),
                "target_n_in_cells": int(sum(item[3] for item in cell_effects)),
            }
    return result


def ipw_mean_differences(frame: pd.DataFrame, primary: list[str], baseline: str) -> dict[str, Any]:
    eligible = frame[frame["reviewer_model"].isin(primary)].copy()
    classes = [baseline] + [model for model in primary if model != baseline]
    eligible = eligible[eligible["reviewer_model"].isin(classes)]
    x, names = propensity_design(eligible)
    try:
        propensities = multinomial_propensity(eligible["reviewer_model"].to_numpy(), x, classes)
    except Exception as exc:
        return {"available": False, "reason": str(exc)}

    output: dict[str, Any] = {"available": True, "classes": classes, "covariates": names, "contrasts": {}}
    treatment = eligible["reviewer_model"].to_numpy()
    for outcome, column in {"score": "score", "cost": "workflow_cost", "intervention_rate": "intervention_required_int"}.items():
        y = eligible[column].astype(float).to_numpy()
        output["contrasts"][outcome] = {}
        for target in classes:
            if target == baseline:
                continue
            target_index = classes.index(target)
            baseline_index = classes.index(baseline)
            target_weights = ((treatment == target) / np.clip(propensities[:, target_index], 0.02, 0.98)).astype(float)
            baseline_weights = ((treatment == baseline) / np.clip(propensities[:, baseline_index], 0.02, 0.98)).astype(float)
            target_mean = np.sum(target_weights * y) / np.sum(target_weights)
            baseline_mean = np.sum(baseline_weights * y) / np.sum(baseline_weights)
            output["contrasts"][outcome][target] = float(target_mean - baseline_mean)
    return output


def propensity_design(frame: pd.DataFrame) -> tuple[np.ndarray, list[str]]:
    columns = [np.ones(len(frame)), frame["complexity"].astype(float).to_numpy()]
    names = ["Intercept", "complexity"]
    for field in ["task_type", "domain"]:
        levels = sorted(frame[field].dropna().astype(str).unique())
        for level in levels[1:]:
            names.append(f"{field}:{level}")
            columns.append((frame[field].astype(str) == level).astype(float).to_numpy())
    return np.column_stack(columns), names


def score_cluster_bootstrap(frame: pd.DataFrame, primary: list[str], baseline: str, iterations: int) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for target in primary:
        if target == baseline:
            continue
        subset = frame[frame["reviewer_model"].isin([baseline, target])]
        if subset.empty:
            continue

        def statistic(sampled_scores: np.ndarray, sampled_models: np.ndarray = subset["reviewer_model"].to_numpy()) -> float:
            target_scores = sampled_scores[sampled_models[: len(sampled_scores)] == target]
            baseline_scores = sampled_scores[sampled_models[: len(sampled_scores)] == baseline]
            if len(target_scores) == 0 or len(baseline_scores) == 0:
                return float("nan")
            return float(np.nanmean(target_scores) - np.nanmean(baseline_scores))

        values = np.array(list(zip(subset["score"].to_numpy(), subset["reviewer_model"].to_numpy())), dtype=object)

        def paired_stat(sampled: np.ndarray) -> float:
            scores = sampled[:, 0].astype(float)
            models = sampled[:, 1]
            return float(np.nanmean(scores[models == target]) - np.nanmean(scores[models == baseline]))

        low, high = cluster_bootstrap_ci(values, subset["issue_id"].to_numpy(), paired_stat, iterations=iterations)
        output[target] = {"ci_low": low, "ci_high": high, "iterations": iterations}
    return output


def evaluate_go_no_go(
    primary_fit: dict[str, Any],
    sensitivities: dict[str, dict[str, Any]],
    frame: pd.DataFrame,
    primary: list[str],
) -> dict[str, Any]:
    baseline_mean_cost = float(frame.loc[frame["reviewer_model"] == BASELINE_REVIEWER, "workflow_cost"].mean())
    triggers = []
    sensitivity_summary: dict[str, Any] = {}
    for target in primary:
        if target == BASELINE_REVIEWER:
            continue
        score = contrast_between_models(primary_fit, "score", target, BASELINE_REVIEWER)
        intervention = contrast_between_models(primary_fit, "intervention_rate", target, BASELINE_REVIEWER)
        cost = contrast_between_models(primary_fit, "cost", target, BASELINE_REVIEWER)
        if score is None or intervention is None or cost is None:
            continue
        sensitivity_summary[target] = {}
        for outcome in ["score", "intervention_rate", "cost"]:
            primary_effect = contrast_between_models(primary_fit, outcome, target, BASELINE_REVIEWER)
            sensitivity_summary[target][outcome] = {
                name: contrast_between_models(result, outcome, target, BASELINE_REVIEWER)
                for name, result in sensitivities.items()
            }
            sensitivity_summary[target][outcome]["survives"] = sensitivity_survives(primary_effect, sensitivity_summary[target][outcome])

        if abs(score["estimate"]) >= 0.05 and excludes_zero(score) and sensitivity_summary[target]["score"]["survives"]:
            triggers.append({"reviewer": target, "metric": "score", **score})
        if abs(intervention["estimate"]) >= 0.05 and excludes_zero(intervention) and sensitivity_summary[target]["intervention_rate"]["survives"]:
            triggers.append({"reviewer": target, "metric": "intervention_rate", **intervention})

        relative_cost = cost["estimate"] / baseline_mean_cost if baseline_mean_cost else 0.0
        score_equivalent = score["ci_low"] > -0.05 if cost["estimate"] < 0 else score["ci_high"] < 0.05
        if abs(relative_cost) >= 0.30 and score_equivalent and sensitivity_summary[target]["cost"]["survives"]:
            triggers.append({"reviewer": target, "metric": "cost_efficiency", "relative_cost_delta": relative_cost, **cost})

    score_half_widths = []
    for target in primary:
        if target == BASELINE_REVIEWER:
            continue
        score = contrast_between_models(primary_fit, "score", target, BASELINE_REVIEWER)
        if score:
            score_half_widths.append(abs(score["ci_high"] - score["estimate"]))

    return {
        "recommendation": "Go" if triggers else "No-Go",
        "triggers": triggers,
        "decision_rule": "Go if score >=0.05, intervention-rate >=5pp, or cost-efficiency >=30% has a 95% CI excluding zero and survives S1/S2/S3.",
        "sensitivity_direction_checks": sensitivity_summary,
        "score_mde_approx_95pct": float(min(score_half_widths)) if score_half_widths else None,
        "rationale": (
            "At least one precommitted reviewer contrast clears the effect-size, CI, and sensitivity gates."
            if triggers
            else "No reviewer contrast clears the precommitted effect-size, confidence-interval, and sensitivity gates on the current observational corpus."
        ),
    }


def sensitivity_survives(primary_effect: dict[str, float] | None, blocks: dict[str, Any]) -> bool:
    if primary_effect is None or primary_effect["estimate"] == 0:
        return False
    primary_sign = np.sign(primary_effect["estimate"])
    for name, effect in blocks.items():
        if name == "survives":
            continue
        if effect is None:
            return False
        if effect["estimate"] == 0 or np.sign(effect["estimate"]) != primary_sign:
            return False
    return True


def excludes_zero(effect: dict[str, float]) -> bool:
    return effect["ci_low"] > 0 or effect["ci_high"] < 0


def normalization_drop_rate(metadata: dict[str, Any]) -> float:
    counts = metadata.get("normalization_counts", {})
    logged = sum(int(counts.get(key, 0)) for key in ["unresolvable", "alias", "canonical"])
    dropped = int(counts.get("unresolvable", 0))
    return dropped / logged if logged else 0.0


def write_report(path: Path, summary: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    go = summary["go_no_go"]
    primary = summary["primary_estimates"]
    data = summary["data"]

    lines = [
        "# Hokusai reviewer-router B1 analysis",
        "",
        f"Generated from `{data['source']}` on {summary['generated_at']}.",
        "",
        "## Recommendation",
        "",
        f"Recommendation: {go['recommendation']}",
        "",
        go["rationale"],
        "",
        "## Corpus",
        "",
        f"- Total eval records scanned: {data['total_records']}",
        f"- Logged reviewer rows used after normalization and complete-case filtering: {data['used_rows']}",
        f"- Primary reviewer threshold: n >= {summary['min_primary_reviewer_n']}",
        f"- Primary reviewers: {', '.join(data['primary_reviewers'])}",
        f"- Baseline reviewer: {summary['baseline_reviewer']}",
        f"- Latest-three schema sensitivity cohort: {', '.join(data['latest_three_schema_versions'])}",
        f"- Reviewer normalization counts: `{json.dumps(data['normalization_counts'], sort_keys=True)}`",
        "",
        "## Descriptives",
        "",
        "| Reviewer | n | Mean score | Mean complexity | Mean workflow cost | Intervention rate | Success rate |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for reviewer, row in sorted(summary["descriptives"].items(), key=lambda item: item[1]["n"], reverse=True):
        lines.append(
            f"| {reviewer} | {row['n']} | {row['mean_score']:.3f} | {row['mean_complexity']:.2f} | "
            f"${row['mean_workflow_cost']:.2f} | {row['intervention_rate']:.1%} | {row['success_rate']:.1%} |"
        )

    lines.extend(
        [
            "",
            "## Method",
            "",
            "The primary model is an observational regression over rows with logged reviewer model, complete score/cost/complexity fields, and local reviewer-name normalization. The specification is `outcome ~ reviewer + complexity + task_type + domain`; OLS outcomes use HC1 robust standard errors. Binary intervention is reported as a linear-probability effect for percentage-point interpretation, with a logistic fit retained in `summary.json` as a sanity check. Cost uses `workflowCost` as the downstream workflow-cost outcome and also reports `estimatedCost` in the machine-readable artifact.",
            "",
            "Sensitivity checks rerun the same contrast under the latest-three schema cohort, `trainingEligible=True`, and an alternate `gpt-5.5` baseline. The placebo regresses prompt diagnostic bytes on reviewer choice with the same controls; reviewer choice should not causally change the input prompt size, so non-zero placebo contrasts are treated as confounding evidence.",
            "",
            "## Primary estimates",
            "",
            f"Contrasts are adjusted differences versus `{summary['baseline_reviewer']}`. Score/cost/intervention CIs are 95%.",
            "",
            "| Reviewer | Score delta | 95% CI | Cost delta | 95% CI | Intervention delta | 95% CI | Placebo bytes delta |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )

    for reviewer in data["primary_reviewers"]:
        if reviewer == summary["baseline_reviewer"]:
            continue
        score = contrast_between_models(primary, "score", reviewer, summary["baseline_reviewer"])
        cost = contrast_between_models(primary, "cost", reviewer, summary["baseline_reviewer"])
        intervention = contrast_between_models(primary, "intervention_rate", reviewer, summary["baseline_reviewer"])
        placebo = contrast_between_models(primary, "placebo_prompt_bytes", reviewer, summary["baseline_reviewer"])
        if not score or not cost or not intervention or not placebo:
            continue
        lines.append(
            f"| {reviewer} | {score['estimate']:.3f} | [{score['ci_low']:.3f}, {score['ci_high']:.3f}] | "
            f"${cost['estimate']:.2f} | [${cost['ci_low']:.2f}, ${cost['ci_high']:.2f}] | "
            f"{intervention['estimate']:.1%} | [{intervention['ci_low']:.1%}, {intervention['ci_high']:.1%}] | "
            f"{placebo['estimate']:.0f} [{placebo['ci_low']:.0f}, {placebo['ci_high']:.0f}] |"
        )

    lines.extend(
        [
            "",
        "## Sensitivity and checks",
            "",
            "| Reviewer | Outcome | Latest schemas | Training eligible | gpt-5.5 baseline | Direction survives |",
            "| --- | --- | ---: | ---: | ---: | --- |",
        ]
    )
    for reviewer, outcomes in go["sensitivity_direction_checks"].items():
        for outcome, block in outcomes.items():
            latest = block.get("latest_three_schema_versions")
            eligible = block.get("training_eligible")
            alt = block.get("gpt_5_5_baseline")
            lines.append(
                f"| {reviewer} | {outcome} | {_fmt_effect(latest)} | {_fmt_effect(eligible)} | {_fmt_effect(alt)} | {block.get('survives')} |"
            )

    lines.extend(
        [
            "",
            "Cluster bootstrap score intervals by `issueId`:",
            "",
            "| Reviewer | 95% bootstrap CI |",
            "| --- | ---: |",
        ]
    )
    for reviewer, block in summary["cluster_bootstrap_score_ci"].items():
        lines.append(f"| {reviewer} | [{block['ci_low']:.3f}, {block['ci_high']:.3f}] |")

    lines.extend(
        [
            "",
            "IPW mean differences are included in `summary.json` as a doubly-robust direction check.",
            "",
            "## Challenge appendix",
            "",
            "Challenge records vary coder/challenger assignment rather than reviewer assignment, so they are descriptive only and are not used for the reviewer-effect estimate.",
            "",
            f"- Reviewer-logged eval rows with a `challengePairId`: {summary['challenge_appendix']['eval_challenge_tagged_rows']}",
            f"- Sibling `challenge-records.jsonl` rows scanned: {summary['challenge_appendix']['challenge_records_rows']}",
            f"- Challenge-record primary model counts: `{json.dumps(summary['challenge_appendix']['primary_model_counts'], sort_keys=True)}`",
            f"- Challenge-record challenger model counts: `{json.dumps(summary['challenge_appendix']['challenger_model_counts'], sort_keys=True)}`",
            "",
            "## Limitations",
            "",
            "- This is observational, not randomized. Complexity, task type, and domain reduce visible confounding but cannot remove unobserved routing policy differences.",
            "- Fine-signature cells are sparse; the regression carries more of the estimate than the within-cell contrast table.",
            "- The prompt-size placebo shows how much reviewer assignment remains entangled with task shape after controls.",
            f"- Approximate detectable score delta at 95% confidence in the current corpus: {go['score_mde_approx_95pct']:.3f}.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _fmt_effect(effect: dict[str, float] | None) -> str:
    if effect is None:
        return "n/a"
    return f"{effect['estimate']:.3f}"


def challenge_appendix(frame: pd.DataFrame, evals_source: Path) -> dict[str, Any]:
    challenge_rows = frame[frame["challenge_pair_id"].notna()]
    appendix: dict[str, Any] = {
        "eval_challenge_tagged_rows": int(len(challenge_rows)),
        "reviewer_counts_on_challenge_tagged_evals": {
            str(k): int(v) for k, v in challenge_rows["reviewer_model"].value_counts().items()
        },
        "challenge_records_path": str(evals_source.with_name("challenge-records.jsonl")),
        "challenge_records_rows": 0,
        "primary_model_counts": {},
        "challenger_model_counts": {},
        "winner_model_counts": {},
    }
    challenge_path = evals_source.with_name("challenge-records.jsonl")
    if not challenge_path.exists():
        appendix["missing_reason"] = "challenge-records.jsonl not found next to evals source"
        return appendix

    primary_counts: dict[str, int] = {}
    challenger_counts: dict[str, int] = {}
    winner_counts: dict[str, int] = {}
    with challenge_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            appendix["challenge_records_rows"] += 1
            _count(primary_counts, record.get("primaryModel"))
            _count(challenger_counts, record.get("challengerModel"))
            _count(winner_counts, record.get("winnerModel"))
    appendix["primary_model_counts"] = dict(sorted(primary_counts.items(), key=lambda item: (-item[1], item[0])))
    appendix["challenger_model_counts"] = dict(sorted(challenger_counts.items(), key=lambda item: (-item[1], item[0])))
    appendix["winner_model_counts"] = dict(sorted(winner_counts.items(), key=lambda item: (-item[1], item[0])))
    return appendix


def _count(counts: dict[str, int], value: Any) -> None:
    if value is None:
        return
    key = str(value)
    counts[key] = counts.get(key, 0) + 1


if __name__ == "__main__":
    main()
