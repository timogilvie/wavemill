from pathlib import Path

import pandas as pd

from data_prep import derive_signature, latest_schema_versions, load_evals, normalize_reviewer, primary_reviewers


def test_reviewer_normalization_table():
    assert normalize_reviewer("claude-haiku-4-5") == ("claude-haiku-4-5-20251001", "alias")
    assert normalize_reviewer("gpt-5.4") == ("gpt-5.4", "canonical")
    assert normalize_reviewer("deep") == (None, "unresolvable")
    assert normalize_reviewer(None) == (None, "missing")


def test_load_evals_drops_missing_and_unresolvable_reviewers(tmp_path: Path):
    source = tmp_path / "evals.jsonl"
    records = [
        make_record("ok-1", "claude-haiku-4-5"),
        make_record("drop-1", None),
        make_record("drop-2", "deep"),
    ]
    source.write_text("\n".join(records) + "\n", encoding="utf-8")
    frame, metadata = load_evals(source)
    assert len(frame) == 1
    assert frame.iloc[0]["reviewer_model"] == "claude-haiku-4-5-20251001"
    assert metadata["normalization_counts"]["alias"] == 1
    assert metadata["normalization_counts"]["missing"] == 1
    assert metadata["normalization_counts"]["unresolvable"] == 1


def test_signature_derivation_is_deterministic():
    signatures = [derive_signature("Feature", 3.0, "Full-Stack") for _ in range(20)]
    assert signatures == ["feature|c3|full-stack"] * 20


def test_latest_schema_versions_semver_order():
    frame = pd.DataFrame({"schema_version": ["1.9.0", "1.10.0", "1.8.1", "1.11.0"]})
    assert latest_schema_versions(frame, 3) == ["1.9.0", "1.10.0", "1.11.0"]


def test_primary_reviewers_threshold_order():
    frame = pd.DataFrame({"reviewer_model": ["a"] * 3 + ["b"] * 2 + ["c"]})
    assert primary_reviewers(frame, min_n=2) == ["a", "b"]


def make_record(record_id: str, reviewer):
    import json

    record = {
        "id": record_id,
        "schemaVersion": "1.1.0",
        "timestamp": "2026-01-01T00:00:00Z",
        "score": 0.9,
        "estimatedCost": 0.2,
        "workflowCost": 4.0,
        "interventionRequired": False,
        "interventionCount": 0,
        "trainingEligible": True,
        "outcomes": {"success": True},
        "promptSizeDiagnostic": {"totalBytes": 1000},
        "taskDescriptor": {
            "signals": {
                "heuristic": {"task_type": "feature"},
                "learned": {"complexity": 3, "domain": "backend"},
            },
            "stages": {"reviewer": {"model": reviewer, "score": 0.8}},
        },
    }
    return json.dumps(record)
