# Terminal Lifecycle Certification Fixtures

These fixtures are thin setup wrappers for `tests/lib/terminal-lifecycle-cert-harness.sh`.
Each file defines one `cert_setup_<name>` function and delegates common bare-remote,
private-tmux, PR-fixture, and state seeding work to the shared cert harness.

