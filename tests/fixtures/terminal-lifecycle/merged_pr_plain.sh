#!/usr/bin/env bash
set -euo pipefail

cert_setup_merged_pr_plain() {
  cert_setup_delivery "merged-pr-plain" "merge" "${1:-shadow}"
}
