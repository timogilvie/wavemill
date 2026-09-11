#!/usr/bin/env bash
set -euo pipefail

cert_setup_rebase_delivery() {
  cert_setup_delivery "rebase-delivery" "rebase" "${1:-shadow}"
}

