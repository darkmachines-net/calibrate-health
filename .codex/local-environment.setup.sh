#!/usr/bin/env bash
# Forward Codex setup to the host Node entry point so it shares the same configuration path.
set -euo pipefail

node .codex/local-environment.setup.mjs
