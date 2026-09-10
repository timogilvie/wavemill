#!/usr/bin/env bash
# HOK-2957 lifecycle certification runner.
#
# Wraps tests/lifecycle-certification.test.sh + fault suite; supports:
#   --runs N          — run the matrix N times (default 2; per packet
#                       validation the full matrix runs twice — the second
#                       pass doubles as the leak/idempotence check)
#   --filter <name>   — only scenarios whose id contains <name>
#   --report-dir DIR  — override REPORT_DIR (default: /tmp/wavemill-cert-report)
#   --soak-iterations N — mini local soak: loop the matrix N times
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS=2
FILTER=""
REPORT_DIR="${TMPDIR:-/tmp}/wavemill-cert-report"
SOAK_ITERATIONS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
    --report-dir) REPORT_DIR="$2"; shift 2 ;;
    --soak-iterations) SOAK_ITERATIONS="$2"; shift 2 ;;
    -h|--help)
      cat <<USAGE
Usage: bash tests/run-lifecycle-certification.sh [--runs N] [--filter NAME] [--report-dir DIR] [--soak-iterations N]
USAGE
      exit 0
      ;;
    *)
      echo "run-lifecycle-certification.sh: unknown arg '$1'" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$REPORT_DIR"
export REPORT_DIR
export CERT_FILTER="$FILTER"

run_once() {
  echo ""
  echo "=== Lifecycle Certification (pass $1) ==="
  bash "$SCRIPT_DIR/lifecycle-certification.test.sh"
  bash "$SCRIPT_DIR/lifecycle-certification-faults.test.sh"
}

for i in $(seq 1 "$RUNS"); do
  run_once "$i"
done

if (( SOAK_ITERATIONS > 0 )); then
  echo ""
  echo "=== Local mini-soak: $SOAK_ITERATIONS iteration(s) ==="
  for i in $(seq 1 "$SOAK_ITERATIONS"); do
    echo ">>> soak iteration $i"
    bash "$SCRIPT_DIR/lifecycle-certification.test.sh"
  done
fi

echo ""
echo "Reports under: $REPORT_DIR"
