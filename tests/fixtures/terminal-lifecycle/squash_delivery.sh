#!/usr/bin/env bash
set -euo pipefail

cert_setup_squash_delivery() {
  cert_setup_delivery "squash-delivery" "squash" "${1:-shadow}"
}

