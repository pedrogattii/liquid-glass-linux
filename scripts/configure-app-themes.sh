#!/usr/bin/env bash
# Opt-in, per-user application assets. No app startup/restart or system writes.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v python3 >/dev/null || { echo 'Se requiere python3.' >&2; exit 1; }
exec python3 - "$repo_dir" "$@" <<'PY'
import argparse
import ast
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone

repo = Path(sys.argv.pop(1))
parser = argparse.ArgumentParser(description='Temas de aplicaciones; por defecto sólo muestra el plan.')
parser.add_argument('target', nargs='?', choices=['ptyxis', 'ghostty', 'firefox', 'brave'])
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--apply', action='store_true', help='Guardar archivos y preferencias explícitamente')
mode.add_argument('--dry-run', action='store_true', help='Mostrar el plan sin escribir (predeterminado)')
parser.add_argument('--profile', help='UUID existente de Ptyxis o directorio existente de perfil Firefox')
parser.add_argument('--restore', type=Path, help='Directorio de backup generado por esta herramienta')
args = parser.parse_args()
assets = repo / 'assets/app-themes'
home = Path.home()
config = Path(os.environ.get('XDG_CONFIG_HOME') or home / '.config')
data = Path(os.environ.get('XDG_DATA_HOME') or home / '.local/share')
state = Path(os.environ.get('XDG_STATE_HOME') or home / '.local/state')
marker = 'LIQUID GLASS LINUX APP THEME'

def fail(message):
    raise RuntimeError(message)

def safe_path(path):
    path = Path(os.path.abspath(path))
    forbidden = ['/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev', '/root']
    if any(path == Path(root) or Path(root) in path.parents for root in forbidden):
        fail(f'Sólo se permiten rutas del usuario: {path}')
    for item in [path, *path.parents]:
        if item.is_symlink():
            fail(f'No se reemplazan enlaces simbólicos: {item}')
    if path.exists() and path.stat().st_uid != os.getuid():
        fail(f'La ruta no pertenece al usuario actual: {path}')
    return path

def read(path):
    path = safe_path(path)
    if path.exists() and not stat.S_ISREG(path.stat().st_mode):
        fail(f'Se esperaba un archivo regular: {path}')
    return path.read_bytes() if path.exists() else None

def digest(value):
    return hashlib.sha256(value).hexdigest() if value is not None else None

def atomic_write(path, value, mode=0o600):
    path = safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.liquid-glass-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(value)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def merge(path, content, comment):
    old = read(path)
    existing = old.decode('utf-8') if old is not None else ''
    begin = f'{comment[0]} BEGIN {marker}{comment[1]}'
    end = f'{comment[0]} END {marker}{comment[1]}'
    if existing.count(begin) != existing.count(end) or existing.count(begin) > 1:
        fail(f'Bloque de tema incompleto o duplicado en {path}; revisar manualmente.')
    block = f'{begin}\n{content.rstrip()}\n{end}\n'
    if begin in existing:
        if existing.index(end) < existing.index(begin):
            fail(f'Marcadores de tema invertidos en {path}')
        existing = re.sub(re.escape(begin) + r'.*?' + re.escape(end) + r'\n?', lambda _: block,
                          existing, count=1, flags=re.S)
    else:
        existing += ('\n' if existing and not existing.endswith('\n') else '') + block
    return existing.encode('utf-8')

def gs(*values):
    if not shutil.which('gsettings'):
        fail('gsettings no está disponible; Ptyxis nativo es necesario para este destino.')
    result = subprocess.run(['gsettings', *values], check=False, text=True, capture_output=True)
    if result.returncode:
        fail(f'gsettings {values[0]} falló: {result.stderr.strip()}')
    return result.stdout.strip()

def profile_schema(profile):
    if not re.fullmatch(r'(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})', profile):
        fail('El perfil Ptyxis debe ser un UUID existente, sin rutas ni comandos.')
    return f'org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/{profile}/'

def save_manifest(folder, manifest):
    atomic_write(folder / 'restore.json', (json.dumps(manifest, indent=2) + '\n').encode())

def setting_value_valid(key, value):
    if not isinstance(value, str):
        return False
    try:
        decoded = ast.literal_eval(value)
    except (ValueError, SyntaxError):
        return False
    if key == 'palette':
        return isinstance(decoded, str)
    return type(decoded) in (int, float) and math.isfinite(decoded) and 0 <= decoded <= 1

def restore(folder):
    folder = safe_path(folder)
    manifest_path = safe_path(folder / 'restore.json')
    manifest = json.loads(read(manifest_path))
    if manifest.get('version') != 1 or manifest.get('tool') != 'liquid-glass-app-themes':
        fail('Backup no compatible.')
    # Read every payload and capture the entire current state before any write.
    # A missing/corrupt later payload must never leave an earlier file restored.
    planned_files = []
    planned_settings = []
    seen_files = set()
    seen_settings = set()
    for item in manifest['files']:
        path = safe_path(item['path'])
        if str(path) in seen_files:
            fail('Archivo duplicado en el backup.')
        seen_files.add(str(path))
        current = read(path)
        if digest(current) != item['after']:
            fail(f'El archivo cambió después de aplicar el tema: {path}; recuperar el backup manualmente.')
        payload = None
        if item['before'] is not None:
            if not re.fullmatch(r'file-\d+\.backup', item['before']):
                fail('Nombre de backup no válido.')
            payload_path = safe_path(folder / item['before'])
            payload = read(payload_path)
            if payload is None:
                fail(f'Falta un archivo del backup: {payload_path}')
            expected = item.get('before_hash')
            if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected) or digest(payload) != expected:
                fail(f'Integridad de backup no válida: {payload_path}')
        if type(item['mode']) is not int or not 0 <= item['mode'] <= 0o7777:
            fail('Permisos de backup no válidos.')
        planned_files.append({'path': path, 'payload': payload, 'mode': item['mode'],
                              'current': current,
                              'current_mode': stat.S_IMODE(path.stat().st_mode) if current is not None else 0o600})
    for item in manifest['settings']:
        if item['schema'] != profile_schema(item['profile']):
            fail('Schema de backup no válido.')
        identity = (item['schema'], item['key'])
        if identity in seen_settings:
            fail('Preferencia duplicada en el backup.')
        seen_settings.add(identity)
        if item['key'] not in ['palette', 'opacity'] or not all(
                setting_value_valid(item['key'], item[field]) for field in ['before', 'after']):
            fail('Clave o valor de preferencia de backup no válido.')
        current = gs('get', item['schema'], item['key'])
        if current != item['after']:
            fail(f'La preferencia {item["key"]} cambió después de aplicar el tema.')
        if gs('writable', item['schema'], item['key']) != 'true':
            fail(f'La preferencia {item["key"]} no admite escritura.')
        planned_settings.append({**item, 'current': current})
    print(f'Restaurar {len(planned_files)} archivos y {len(planned_settings)} preferencias desde {folder}')
    if not args.apply:
        print('DRY-RUN: no se guardó ningún cambio. Usá --apply para restaurar.')
        return
    attempted_files = []
    attempted_settings = []
    try:
        for item in planned_settings:
            attempted_settings.append(item)
            gs('set', item['schema'], item['key'], item['before'])
        for item in planned_files:
            attempted_files.append(item)
            if item['payload'] is None:
                item['path'].unlink(missing_ok=True)
            else:
                atomic_write(item['path'], item['payload'], item['mode'])
    except Exception as error:
        rollback_errors = []
        # Include the failing operation: a backend can write before reporting an
        # error. All restoration data is already in memory, independent of disk.
        for item in reversed(attempted_files):
            try:
                if item['current'] is None:
                    item['path'].unlink(missing_ok=True)
                else:
                    atomic_write(item['path'], item['current'], item['current_mode'])
            except Exception as rollback_error:
                rollback_errors.append(f'{item["path"]}: {rollback_error}')
        for item in reversed(attempted_settings):
            try:
                gs('set', item['schema'], item['key'], item['current'])
            except Exception as rollback_error:
                rollback_errors.append(f'{item["key"]}: {rollback_error}')
        if rollback_errors:
            fail(f'Restauración fallida ({error}); rollback incompleto: {"; ".join(rollback_errors)}. Backup: {folder}')
        fail(f'Restauración fallida ({error}); se recuperó el estado anterior al intento.')
    print('Backup restaurado. Ninguna aplicación fue reiniciada.')

try:
    if os.geteuid() == 0:
        fail('Ejecutá esta herramienta como usuario normal, sin sudo.')
    if args.restore:
        if args.target or args.profile:
            fail('--restore no se combina con destino ni --profile.')
        restore(args.restore)
        sys.exit(0)
    if not args.target:
        parser.error('Se requiere un destino o --restore.')
    if args.profile and args.target not in ['firefox', 'ptyxis']:
        fail('--profile sólo se usa con Firefox o Ptyxis.')
    files = []
    settings = []
    if args.target == 'firefox':
        if not args.profile:
            fail('Firefox requiere --profile /ruta/al/perfil; no se elige un perfil automáticamente.')
        profile = safe_path(Path(args.profile).expanduser())
        if not profile.is_dir():
            fail('El directorio del perfil Firefox debe existir.')
        for name, source, comment in [
            ('chrome/userChrome.css', 'userChrome.css', ('/*', ' */')),
            ('user.js', 'user.js', ('//', '')),
        ]:
            destination = profile / name
            files.append((destination, merge(destination, (assets / 'firefox' / source).read_text(), comment)))
    elif args.target == 'ghostty':
        directory = config / 'ghostty'
        # Current releases read legacy config later, so preserve that precedence.
        destination = directory / ('config' if (directory / 'config').exists() else 'config.ghostty')
        files.extend([
            (directory / 'themes/Liquid Glass', (assets / 'ghostty/Liquid Glass').read_bytes()),
            (directory / 'liquid-glass.conf', (assets / 'ghostty/liquid-glass.conf').read_bytes()),
            (destination, merge(destination, 'config-file = "liquid-glass.conf"', ('#', ''))),
        ])
    elif args.target == 'brave':
        destination = data / 'liquid-glass-linux/brave-theme/manifest.json'
        files.append((destination, (assets / 'brave/manifest.json').read_bytes()))
        print(f'Tema local para carga manual: brave://extensions → Modo desarrollador → Cargar descomprimida → {destination.parent}')
    elif args.target == 'ptyxis':
        profile = args.profile or ast.literal_eval(gs('get', 'org.gnome.Ptyxis', 'default-profile-uuid'))
        schema = profile_schema(profile)
        registered = ast.literal_eval(gs('get', 'org.gnome.Ptyxis', 'profile-uuids').removeprefix('@as '))
        if profile not in registered:
            fail('El UUID no está registrado en Ptyxis. Creá/elegí un perfil en Ptyxis antes de aplicar.')
        keys = gs('list-keys', schema).splitlines()
        if not {'palette', 'opacity'}.issubset(keys):
            fail('Esta versión de Ptyxis no ofrece palette y opacity por perfil.')
        files.append((data / 'org.gnome.Ptyxis/palettes/liquid-glass.palette',
                      (assets / 'ptyxis/liquid-glass.palette').read_bytes()))
        for key, value in [('palette', "'liquid-glass'"), ('opacity', '0.84')]:
            settings.append({'profile': profile, 'schema': schema, 'key': key,
                             'before': gs('get', schema, key), 'value': value})
    files = [(safe_path(path), value) for path, value in files]
    for path, value in files:
        print(f'Archivo: {path} ({len(value)} bytes; se conserva backup si existe)')
    for item in settings:
        print(f'Preferencia: {item["schema"]} {item["key"]}: {item["before"]} → {item["value"]}')
    if not args.apply:
        print('DRY-RUN: no se guardó ningún cambio. Usá --apply para aplicar este plan.')
        sys.exit(0)
    backup = safe_path(state / 'liquid-glass-linux/app-themes' /
        (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8]))
    backup.mkdir(parents=True, mode=0o700)
    manifest = {'tool': 'liquid-glass-app-themes', 'version': 1, 'target': args.target, 'files': [],
                'settings': [{**item, 'after': item['value']} for item in settings]}
    for index, (path, value) in enumerate(files):
        old = read(path)
        filename = f'file-{index}.backup' if old is not None else None
        permission = stat.S_IMODE(path.stat().st_mode) if old is not None else 0o600
        if old is not None:
            atomic_write(backup / filename, old)
        manifest['files'].append({'path': str(path), 'before': filename,
                                  'mode': permission, 'before_hash': digest(old), 'after': digest(value)})
    save_manifest(backup, manifest)
    applied_files = []
    applied_settings = []
    try:
        for path, value in files:
            entry = next(item for item in manifest['files'] if item['path'] == str(path))
            atomic_write(path, value, entry['mode'])
            applied_files.append(entry)
        for item in settings:
            gs('set', item['schema'], item['key'], item['value'])
            applied_settings.append(item)
            entry = next(saved for saved in manifest['settings'] if saved['key'] == item['key'])
            entry['after'] = gs('get', item['schema'], item['key'])
            save_manifest(backup, manifest)
    except Exception:
        # Roll back only operations completed by this invocation.
        for item in reversed(applied_settings):
            gs('set', item['schema'], item['key'], item['before'])
        for item in reversed(applied_files):
            if item['before'] is None:
                Path(item['path']).unlink(missing_ok=True)
            else:
                atomic_write(item['path'], (backup / item['before']).read_bytes(), item['mode'])
        raise
    print(f'Aplicado. Backup: {backup}')
    print(f'Para deshacer: {repo / "scripts/configure-app-themes.sh"} --restore "{backup}" --apply')
    print('Ninguna aplicación fue iniciada o reiniciada.')
except (RuntimeError, OSError, ValueError, SyntaxError, TypeError, KeyError) as error:
    print(f'Error: {error}', file=sys.stderr)
    sys.exit(1)
PY
