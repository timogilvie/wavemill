from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd


MIN_PRIMARY_REVIEWER_N = 30
DROP_REVIEWER_SENTINELS = {"", "none", "null", "deep"}
REVIEWER_ALIASES = {
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
}


def nested_get(record: dict[str, Any], path: str, default: Any = None) -> Any:
    value: Any = record
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return default
        value = value[part]
    return value


def normalize_reviewer(raw_model: Any) -> tuple[str | None, str]:
    if raw_model is None:
        return None, "missing"
    model = str(raw_model).strip()
    if model.lower() in DROP_REVIEWER_SENTINELS:
        return None, "unresolvable"
    canonical = REVIEWER_ALIASES.get(model, model)
    if canonical != model:
        return canonical, "alias"
    return canonical, "canonical"


def derive_signature(task_type: Any, complexity: Any, domain: Any) -> str:
    task = str(task_type or "unknown").strip().lower() or "unknown"
    comp = "unknown" if complexity is None or pd.isna(complexity) else str(int(float(complexity)))
    dom = str(domain or "unknown").strip().lower() or "unknown"
    return f"{task}|c{comp}|{dom}"


def semver_key(version: Any) -> tuple[int, ...]:
    if version is None:
        return (0,)
    parts = []
    for piece in str(version).split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            digits = "".join(ch for ch in piece if ch.isdigit())
            parts.append(int(digits) if digits else 0)
    return tuple(parts)


def resolve_default_evals_path(start: Path | None = None) -> Path:
    roots: list[Path] = []
    if start is not None:
        roots.append(start.resolve())
    roots.append(Path.cwd().resolve())
    roots.append(Path(__file__).resolve())

    seen: set[Path] = set()
    candidates: list[Path] = []
    for root in roots:
        for parent in [root, *root.parents]:
            if parent in seen:
                continue
            seen.add(parent)
            candidates.append(parent / ".wavemill" / "evals" / "evals.jsonl")

    for candidate in candidates:
        if candidate.exists():
            return candidate

    searched = "\n".join(str(path) for path in candidates)
    raise FileNotFoundError(f"Unable to find .wavemill/evals/evals.jsonl. Searched:\n{searched}")


def load_evals(path: Path | str | None = None) -> tuple[pd.DataFrame, dict[str, Any]]:
    source = Path(path).expanduser().resolve() if path is not None else resolve_default_evals_path()
    rows: list[dict[str, Any]] = []
    normalization_counts = {"missing": 0, "unresolvable": 0, "alias": 0, "canonical": 0}
    total_records = 0
    malformed_lines = 0

    with source.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            total_records += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                malformed_lines += 1
                continue
            if not isinstance(record, dict):
                malformed_lines += 1
                continue

            raw_reviewer = nested_get(record, "taskDescriptor.stages.reviewer.model")
            reviewer_model, status = normalize_reviewer(raw_reviewer)
            normalization_counts[status] = normalization_counts.get(status, 0) + 1
            if reviewer_model is None:
                continue

            task_type = nested_get(record, "taskDescriptor.signals.heuristic.task_type", "unknown")
            complexity = nested_get(record, "taskDescriptor.signals.learned.complexity")
            domain = nested_get(record, "taskDescriptor.signals.learned.domain", "unknown")
            score = record.get("score")
            estimated_cost = record.get("estimatedCost")
            workflow_cost = record.get("workflowCost")
            descriptor_cost = nested_get(record, "taskDescriptor.outcome.total_cost_usd")

            rows.append(
                {
                    "line_number": line_number,
                    "record_id": record.get("id"),
                    "issue_id": record.get("issueId") or record.get("id") or f"line-{line_number}",
                    "challenge_pair_id": record.get("challengePairId"),
                    "schema_version": record.get("schemaVersion"),
                    "timestamp": record.get("timestamp"),
                    "reviewer_model": reviewer_model,
                    "reviewer_raw": raw_reviewer,
                    "reviewer_normalization": status,
                    "score": float(score) if score is not None else None,
                    "reviewer_score": _to_float(nested_get(record, "taskDescriptor.stages.reviewer.score")),
                    "estimated_cost": _to_float(estimated_cost),
                    "workflow_cost": _to_float(workflow_cost if workflow_cost is not None else descriptor_cost),
                    "intervention_required": bool(record.get("interventionRequired", False)),
                    "intervention_count": int(record.get("interventionCount") or 0),
                    "success": bool(nested_get(record, "outcomes.success", False)),
                    "complexity": _to_float(complexity),
                    "task_type": task_type or "unknown",
                    "domain": domain or "unknown",
                    "stratum": record.get("stratum") or "unknown",
                    "fine_signature": derive_signature(task_type, complexity, domain),
                    "training_eligible": bool(record.get("trainingEligible", False)),
                    "prompt_total_bytes": _to_float(nested_get(record, "promptSizeDiagnostic.totalBytes")),
                }
            )

    frame = pd.DataFrame(rows)
    metadata = {
        "source": str(source),
        "total_records": total_records,
        "malformed_lines": malformed_lines,
        "reviewer_rows": int(len(frame)),
        "normalization_counts": normalization_counts,
    }
    if frame.empty:
        return frame, metadata

    frame["timestamp"] = pd.to_datetime(frame["timestamp"], errors="coerce", utc=True)
    frame["schema_rank"] = frame["schema_version"].map(semver_key)
    return frame, metadata


def reviewer_counts(frame: pd.DataFrame) -> dict[str, int]:
    return {str(k): int(v) for k, v in frame["reviewer_model"].value_counts().items()}


def primary_reviewers(frame: pd.DataFrame, min_n: int = MIN_PRIMARY_REVIEWER_N) -> list[str]:
    counts = reviewer_counts(frame)
    return [model for model, count in counts.items() if count >= min_n]


def with_reviewer_bucket(frame: pd.DataFrame, primary: list[str]) -> pd.DataFrame:
    copy = frame.copy()
    primary_set = set(primary)
    copy["reviewer_bucket"] = copy["reviewer_model"].where(copy["reviewer_model"].isin(primary_set), "other_lt30")
    return copy


def latest_schema_versions(frame: pd.DataFrame, count: int = 3) -> list[str]:
    versions = sorted({str(v) for v in frame["schema_version"].dropna().unique()}, key=semver_key)
    return versions[-count:]


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
