#!/usr/bin/env bash
# Isolated fixtures only: every gsettings command resolves to a fake executable.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fixture_dir=$(mktemp -d /tmp/liquid-app-themes-test.XXXXXX)
trap 'rm -rf -- "$fixture_dir"' EXIT
export XDG_CONFIG_HOME="$fixture_dir/config"
export XDG_DATA_HOME="$fixture_dir/data"
export XDG_STATE_HOME="$fixture_dir/state"
export FAKE_GSETTINGS_DB="$fixture_dir/gsettings.json"
export FAKE_GSETTINGS_LOG="$fixture_dir/gsettings.log"
export FAKE_APP_LOG="$fixture_dir/apps.log"
mkdir -p "$fixture_dir/bin" "$fixture_dir/firefox/chrome" "$XDG_CONFIG_HOME/ghostty"
cat > "$fixture_dir/bin/gsettings" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['FAKE_GSETTINGS_DB'])
store = json.loads(path.read_text()) if path.exists() else {}
a = sys.argv[1:]
with open(os.environ['FAKE_GSETTINGS_LOG'], 'a') as log:
    log.write(json.dumps(a) + '\n')
if a[0] == 'writable':
    print('true')
elif a[0] == 'list-keys':
    print('palette\nopacity')
elif a[0] == 'get':
    if a[2] == 'default-profile-uuid': print("'11111111111111111111111111111111'")
    elif a[2] == 'profile-uuids': print("['11111111111111111111111111111111']")
    else: print(store.get(a[2], "'gnome'" if a[2] == 'palette' else '1.0'))
elif a[0] == 'set':
    if a[2] == 'opacity' and a[3] == '0.84' and os.environ.get('FAKE_FAIL_OPACITY'):
        sys.exit(3)
    if a[2] == 'opacity' and a[3] == '1.0' and os.environ.get('FAKE_FAIL_RESTORE'):
        sys.exit(4)
    store[a[2]] = a[3]
    path.write_text(json.dumps(store))
else:
    sys.exit(2)
PY
chmod +x "$fixture_dir/bin/gsettings"
for app in ptyxis ghostty firefox brave pkill killall gnome-extensions; do
    cat > "$fixture_dir/bin/$app" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$0 $*" >> "$FAKE_APP_LOG"
exit 9
SH
    chmod +x "$fixture_dir/bin/$app"
done
export PATH="$fixture_dir/bin:$PATH"
tool="$repo_dir/scripts/configure-app-themes.sh"
expect_failure() {
    if "$@" > "$fixture_dir/error.log" 2>&1; then
        echo "Expected failure: $*" >&2
        exit 1
    fi
}

printf '%s\n' '/* Existing custom tabs */' > "$fixture_dir/firefox/chrome/userChrome.css"
printf '%s\n' 'user_pref("browser.startup.page", 3);' > "$fixture_dir/firefox/user.js"
cp "$fixture_dir/firefox/chrome/userChrome.css" "$fixture_dir/original.css"
cp "$fixture_dir/firefox/user.js" "$fixture_dir/original.js"
printf '%s\n' 'font-size = 13' 'background-opacity = 0.99' > "$XDG_CONFIG_HOME/ghostty/config"
cp "$XDG_CONFIG_HOME/ghostty/config" "$fixture_dir/original.ghostty"

# All targets default to dry run and create no application/config/backup files.
"$tool" firefox --profile "$fixture_dir/firefox" > /dev/null
"$tool" ghostty > /dev/null
"$tool" brave > /dev/null
"$tool" ptyxis > /dev/null
cmp "$fixture_dir/original.css" "$fixture_dir/firefox/chrome/userChrome.css"
cmp "$fixture_dir/original.js" "$fixture_dir/firefox/user.js"
cmp "$fixture_dir/original.ghostty" "$XDG_CONFIG_HOME/ghostty/config"
[[ ! -e "$XDG_STATE_HOME" && ! -e "$XDG_DATA_HOME" && ! -e "$FAKE_GSETTINGS_DB" ]]
expect_failure "$tool" firefox --apply
expect_failure "$tool" firefox --profile /etc --apply
expect_failure "$tool" ghostty --profile ignored

result=$("$tool" firefox --profile "$fixture_dir/firefox" --apply)
backup=$(sed -n 's/^Aplicado. Backup: //p' <<< "$result")
[[ -f "$backup/restore.json" ]]
rg -q 'Existing custom tabs' "$fixture_dir/firefox/chrome/userChrome.css"
rg -q 'browser.startup.page' "$fixture_dir/firefox/user.js"
rg -q 'legacyUserProfileCustomizations.stylesheets.*true' "$fixture_dir/firefox/user.js"
"$tool" firefox --profile "$fixture_dir/firefox" --apply > /dev/null
[[ $(rg -c 'BEGIN LIQUID GLASS' "$fixture_dir/firefox/user.js") == 1 ]]
[[ $(rg -c 'BEGIN LIQUID GLASS' "$fixture_dir/firefox/chrome/userChrome.css") == 1 ]]
# A missing, corrupt or non-regular second payload must not restore the first.
cp "$fixture_dir/firefox/chrome/userChrome.css" "$fixture_dir/applied.css"
cp "$fixture_dir/firefox/user.js" "$fixture_dir/applied.js"
cp "$backup/file-1.backup" "$fixture_dir/payload.saved"
rm "$backup/file-1.backup"
expect_failure "$tool" --restore "$backup" --apply
cmp "$fixture_dir/applied.css" "$fixture_dir/firefox/chrome/userChrome.css"
cmp "$fixture_dir/applied.js" "$fixture_dir/firefox/user.js"
printf '%s\n' 'corrupt payload' > "$backup/file-1.backup"
expect_failure "$tool" --restore "$backup" --apply
cmp "$fixture_dir/applied.css" "$fixture_dir/firefox/chrome/userChrome.css"
cmp "$fixture_dir/applied.js" "$fixture_dir/firefox/user.js"
rm "$backup/file-1.backup"
mkfifo "$backup/file-1.backup"
expect_failure "$tool" --restore "$backup" --apply
cmp "$fixture_dir/applied.css" "$fixture_dir/firefox/chrome/userChrome.css"
cmp "$fixture_dir/applied.js" "$fixture_dir/firefox/user.js"
rm "$backup/file-1.backup"
cp "$fixture_dir/payload.saved" "$backup/file-1.backup"

# Inject an atomic write failure only inside an isolated Python process. The
# production tool has no environment variable or flag that enables injection.
cat > "$fixture_dir/fail-restore.py" <<'PYFAULT'
import os, sys
from pathlib import Path
script, repository, backup, suffix = sys.argv[1:]
source = Path(script).read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
replace = os.replace
failed = False
def fail_once(origin, destination):
    global failed
    if str(destination).endswith(suffix) and not failed:
        failed = True
        raise OSError('injected restore write failure')
    return replace(origin, destination)
os.replace = fail_once
sys.argv = [script, repository, '--restore', backup, '--apply']
exec(compile(source, script, 'exec'))
PYFAULT
expect_failure python3 "$fixture_dir/fail-restore.py" "$tool" "$repo_dir" "$backup" user.js
rg -q 'injected restore write failure' "$fixture_dir/error.log"
rg -q 'se recuperó el estado anterior' "$fixture_dir/error.log"
cmp "$fixture_dir/applied.css" "$fixture_dir/firefox/chrome/userChrome.css"
cmp "$fixture_dir/applied.js" "$fixture_dir/firefox/user.js"
"$tool" --restore "$backup" > /dev/null
rg -q 'BEGIN LIQUID GLASS' "$fixture_dir/firefox/user.js"
"$tool" --restore "$backup" --apply > /dev/null
cmp "$fixture_dir/original.css" "$fixture_dir/firefox/chrome/userChrome.css"
cmp "$fixture_dir/original.js" "$fixture_dir/firefox/user.js"

result=$("$tool" ghostty --apply)
backup=$(sed -n 's/^Aplicado. Backup: //p' <<< "$result")
rg -q '^font-size = 13' "$XDG_CONFIG_HOME/ghostty/config"
rg -q 'config-file = "liquid-glass.conf"' "$XDG_CONFIG_HOME/ghostty/config"
[[ -f "$XDG_CONFIG_HOME/ghostty/themes/Liquid Glass" ]]
[[ ! -e "$XDG_CONFIG_HOME/ghostty/config.ghostty" ]]
"$tool" --restore "$backup" --apply > /dev/null
cmp "$fixture_dir/original.ghostty" "$XDG_CONFIG_HOME/ghostty/config"
[[ ! -e "$XDG_CONFIG_HOME/ghostty/themes/Liquid Glass" ]]
rm "$XDG_CONFIG_HOME/ghostty/config"
result=$("$tool" ghostty --apply)
[[ -f "$XDG_CONFIG_HOME/ghostty/config.ghostty" ]]
backup=$(sed -n 's/^Aplicado. Backup: //p' <<< "$result")
printf '\n# later user edit\n' >> "$XDG_CONFIG_HOME/ghostty/config.ghostty"
expect_failure "$tool" --restore "$backup" --apply
rg -q 'later user edit' "$XDG_CONFIG_HOME/ghostty/config.ghostty"

result=$("$tool" ptyxis --apply)
backup=$(sed -n 's/^Aplicado. Backup: //p' <<< "$result")
rg -q "org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/11111111111111111111111111111111/" "$FAKE_GSETTINGS_LOG"
python3 - "$FAKE_GSETTINGS_DB" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); assert s['palette'] == "'liquid-glass'" and s['opacity'] == '0.84'
PY
# A malformed second preference is rejected before the first is restored.
cp "$backup/restore.json" "$fixture_dir/ptyxis-manifest.saved"
python3 - "$backup/restore.json" <<'PYBAD'
import json, sys
from pathlib import Path
p = Path(sys.argv[1]); value = json.loads(p.read_text())
value['settings'][1]['before'] = "'not a double'"
p.write_text(json.dumps(value))
PYBAD
expect_failure "$tool" --restore "$backup" --apply
python3 - "$FAKE_GSETTINGS_DB" <<'PYUNCHANGED'
import json, sys
s = json.load(open(sys.argv[1])); assert s['palette'] == "'liquid-glass'" and s['opacity'] == '0.84'
PYUNCHANGED
cp "$fixture_dir/ptyxis-manifest.saved" "$backup/restore.json"
# The second settings write fails: the first must return to its applied value.
expect_failure env FAKE_FAIL_RESTORE=1 "$tool" --restore "$backup" --apply
python3 - "$FAKE_GSETTINGS_DB" <<'PYUNCHANGED'
import json, sys
s = json.load(open(sys.argv[1])); assert s['palette'] == "'liquid-glass'" and s['opacity'] == '0.84'
PYUNCHANGED
"$tool" --restore "$backup" --apply > /dev/null
python3 - "$FAKE_GSETTINGS_DB" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); assert s['palette'] == "'gnome'" and s['opacity'] == '1.0'
PY
# If a file restore fails after settings were restored, both settings and file
# return to their exact state immediately before this restore attempt.
mkdir -p "$XDG_DATA_HOME/org.gnome.Ptyxis/palettes"
printf '%s\n' 'previous user palette' > "$XDG_DATA_HOME/org.gnome.Ptyxis/palettes/liquid-glass.palette"
result=$("$tool" ptyxis --apply)
combined_backup=$(sed -n 's/^Aplicado. Backup: //p' <<< "$result")
cp "$XDG_DATA_HOME/org.gnome.Ptyxis/palettes/liquid-glass.palette" "$fixture_dir/applied.palette"
expect_failure python3 "$fixture_dir/fail-restore.py" "$tool" "$repo_dir" "$combined_backup" liquid-glass.palette
cmp "$fixture_dir/applied.palette" "$XDG_DATA_HOME/org.gnome.Ptyxis/palettes/liquid-glass.palette"
python3 - "$FAKE_GSETTINGS_DB" <<'PYUNCHANGED'
import json, sys
s = json.load(open(sys.argv[1])); assert s['palette'] == "'liquid-glass'" and s['opacity'] == '0.84'
PYUNCHANGED
"$tool" --restore "$combined_backup" --apply > /dev/null
rg -q 'previous user palette' "$XDG_DATA_HOME/org.gnome.Ptyxis/palettes/liquid-glass.palette"
rm "$XDG_DATA_HOME/org.gnome.Ptyxis/palettes/liquid-glass.palette"
expect_failure "$tool" ptyxis --profile 22222222222222222222222222222222 --apply
expect_failure env FAKE_FAIL_OPACITY=1 "$tool" ptyxis --apply
python3 - "$FAKE_GSETTINGS_DB" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); assert s['palette'] == "'gnome'" and s['opacity'] == '1.0'
PY
[[ ! -f "$XDG_DATA_HOME/org.gnome.Ptyxis/palettes/liquid-glass.palette" ]]
"$tool" brave --apply > /dev/null
python3 - "$XDG_DATA_HOME/liquid-glass-linux/brave-theme/manifest.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); assert s['manifest_version'] == 3 and 'theme' in s
assert not any(key in s for key in ['content_scripts', 'permissions', 'background'])
PY
[[ ! -e "$FAKE_APP_LOG" ]]
mkdir -p "$fixture_dir/symlink-profile" "$fixture_dir/elsewhere"
ln -s "$fixture_dir/elsewhere" "$fixture_dir/symlink-profile/chrome"
expect_failure "$tool" firefox --profile "$fixture_dir/symlink-profile" --apply
[[ ! -e "$fixture_dir/elsewhere/userChrome.css" ]]
printf '%s\n' 'app themes: dry-run, opt-in, preserve/idempotence, restore, collision, profile validation and rollback checks passed'
