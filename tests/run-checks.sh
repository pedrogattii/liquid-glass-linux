#!/usr/bin/env bash
set -euo pipefail
suite_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$suite_root"
while IFS= read -r source; do node --check "$source"; done < <(rg --files extensions/liquid-island@pedrogatti.local tests -g '*.js' -g '*.mjs')
node tests/overview-lifecycle.mjs
node tests/music-policy.mjs
node --experimental-vm-modules tests/music-service.mjs
node tests/profile-format.mjs
bash tests/app-themes-safe.sh
python3 tests/test-next-boot-update.py
node tests/dock-geometry.mjs
node tests/blur-surfaces.mjs
node tests/messaging-policy.mjs
node --experimental-vm-modules tests/gpu-policy.mjs
node --experimental-vm-modules tests/gpu-service.mjs
node --test --test-isolation=none tests/widgets-layout.mjs tests/widgets-providers.mjs
glib-compile-schemas --strict --dry-run extensions/liquid-island@pedrogatti.local/schemas
bash -n install.sh backup-live.sh scripts/live-wallpaper.sh tests/run-checks.sh tests/run-shell-smoke.sh scripts/configure-app-themes.sh
if command -v git >/dev/null; then git diff --check; fi
