#!/usr/bin/env bash
set -euo pipefail
suite_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != --private-bus-child ]]; then
    suite_tmp=$(mktemp -d /tmp/liquid-shell-test.XXXXXX)
    export XDG_RUNTIME_DIR="$suite_tmp/runtime" XDG_CONFIG_HOME="$suite_tmp/config" XDG_DATA_HOME="$suite_tmp/data" XDG_CACHE_HOME="$suite_tmp/cache" XDG_STATE_HOME="$suite_tmp/state"
    mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
    chmod 700 "$XDG_RUNTIME_DIR"
    export GSETTINGS_BACKEND=keyfile LIQUID_ISOLATED_TEST=1 WAYLAND_DISPLAY=liquid-test-wayland
    export GIO_USE_VFS=local GTK_A11Y=none GTK_USE_PORTAL=0
    exec timeout 60 dbus-run-session -- bash "$suite_root/tests/run-shell-smoke.sh" --private-bus-child
fi
if [[ "${DBUS_SESSION_BUS_ADDRESS:-}" != unix:path=/tmp/dbus-* || "${XDG_RUNTIME_DIR:-}" != /tmp/liquid-shell-test.*/runtime ]]; then
    echo 'Refusing to run without a private temporary session bus and runtime.' >&2
    exit 1
fi
suite_tmp="${XDG_RUNTIME_DIR%/runtime}"
export GSETTINGS_BACKEND=keyfile LIQUID_ISOLATED_TEST=1 WAYLAND_DISPLAY=liquid-test-wayland
export GI_TYPELIB_PATH="/usr/lib64/gnome-shell/girepository-1.0:/usr/lib64/gnome-shell:/usr/lib64/mutter-18${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="/usr/lib64/gnome-shell:/usr/lib64/mutter-18${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=wayland GIO_USE_VFS=local GTK_A11Y=none GTK_USE_PORTAL=0
unset DISPLAY DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE
cd "$suite_root"
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions/liquid-shell-probe@pedrogatti.local"
cp -r extensions/liquid-island@pedrogatti.local "$XDG_DATA_HOME/gnome-shell/extensions/"
if [[ "${LIQUID_TEST_BLUR:-1}" == 1 ]]; then
    cp -r extensions/blur-my-shell@aunetx "$XDG_DATA_HOME/gnome-shell/extensions/"
fi
cp tests/shell-probe.js "$XDG_DATA_HOME/gnome-shell/extensions/liquid-shell-probe@pedrogatti.local/extension.js"
cat > "$XDG_DATA_HOME/gnome-shell/extensions/liquid-shell-probe@pedrogatti.local/metadata.json" <<'JSON'
{"uuid":"liquid-shell-probe@pedrogatti.local","name":"Isolated Liquid Glass Probe","description":"Test-only extension","shell-version":["50"]}
JSON
export GSETTINGS_SCHEMA_DIR="$XDG_DATA_HOME/gnome-shell/extensions/liquid-island@pedrogatti.local/schemas"
glib-compile-schemas --strict "$GSETTINGS_SCHEMA_DIR"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '50.6'
gsettings set org.gnome.shell disable-user-extensions false
if [[ "${LIQUID_TEST_BLUR:-1}" == 1 ]]; then
    gsettings set org.gnome.shell enabled-extensions "['liquid-shell-probe@pedrogatti.local','blur-my-shell@aunetx','liquid-island@pedrogatti.local']"
else
    gsettings set org.gnome.shell enabled-extensions "['liquid-shell-probe@pedrogatti.local','liquid-island@pedrogatti.local']"
fi
gsettings set org.gnome.shell.extensions.liquid-island widgets-enabled "['clock','calendar','weather','cpu','ram','gpu','music','launchers','notes','tasks','timer','discord']"
gsettings set org.gnome.shell.extensions.liquid-island widgets-edit-mode true
rm -f /tmp/liquid-shell-smoke.json
gjs -m tests/mpris-fixture.js > "$suite_tmp/fixture.log" 2>&1 &
suite_fixture=$!
suite_shell=''
cleanup() {
    local original_status=$?
    local shell_status=0
    trap - EXIT
    [[ -z "$suite_shell" ]] || kill "$suite_shell" 2>/dev/null || true
    kill "$suite_fixture" 2>/dev/null || true
    if [[ -n "$suite_shell" ]]; then
        wait "$suite_shell" 2>/dev/null || shell_status=$?
    fi
    wait "$suite_fixture" 2>/dev/null || true
    printf 'Isolated test logs: %s\n' "$suite_tmp"
    if [[ $original_status -eq 0 && $shell_status -ne 0 && $shell_status -ne 143 ]]; then
        printf 'Isolated compositor exited unexpectedly: %s\n' "$shell_status" >&2
        exit 1
    fi
}
trap cleanup EXIT
gnome-shell --headless --wayland --no-x11 --virtual-monitor=1440x1000 --wayland-display="$WAYLAND_DISPLAY" > "$suite_tmp/shell.log" 2>&1 &
suite_shell=$!
for attempt in {1..100}; do
    [[ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] || break
    if ! kill -0 "$suite_shell" 2>/dev/null; then cat "$suite_tmp/shell.log"; exit 1; fi
    sleep 0.1
done
sleep 2
GSETTINGS_BACKEND=memory gjs -m tests/preferences-smoke.js
for attempt in {1..400}; do
    if [[ -f /tmp/liquid-shell-smoke.json ]] && python3 -c 'import json; raise SystemExit(not json.load(open("/tmp/liquid-shell-smoke.json")).get("complete"))'; then break; fi
    if ! kill -0 "$suite_shell" 2>/dev/null; then cat "$suite_tmp/shell.log"; exit 1; fi
    sleep 0.1
done
python3 - <<'PY'
import json
with open('/tmp/liquid-shell-smoke.json') as f:
    report=json.load(f)
for check in report['checks']:
    print(('PASS ' if check['passed'] else 'FAIL ')+check['name'])
if not report.get('complete') or not report.get('passed'):
    raise SystemExit(report.get('error') or 'Shell smoke did not complete')
print('Shell smoke: all real integration checks passed')
PY
