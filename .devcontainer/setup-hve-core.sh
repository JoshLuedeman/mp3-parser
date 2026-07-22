#!/usr/bin/env bash
# Best-effort, idempotent installer for the GitHub Copilot CLI and the
# hve-core-all plugin (github.com/microsoft/hve-core). Shared by the
# copilot-setup-steps workflow and the dev container's postCreateCommand.
#
# Non-fatal by design: every step falls back to a warning instead of
# failing the calling context (cloud sandbox / dev container startup).
set -euo pipefail

command -v copilot >/dev/null 2>&1 || npm install -g @github/copilot || echo "::warning::copilot CLI install failed"
copilot plugin marketplace add microsoft/hve-core || echo "::warning::marketplace add failed"
copilot plugin install hve-core-all@hve-core || echo "::warning::hve-core-all install failed"
copilot plugin list || true
