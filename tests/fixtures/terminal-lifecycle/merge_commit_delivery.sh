#!/usr/bin/env bash
set -euo pipefail

cert_setup_merge_commit_delivery() {
  cert_setup_delivery "merge-commit-delivery" "merge" "${1:-shadow}"
}

