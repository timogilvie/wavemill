#!/usr/bin/env bash
set -euo pipefail

cert_setup_changed_after_review_head() {
  cert_setup_delivery "changed-after-review-head" "changed-after-review" "${1:-shadow}"
}

