#!/usr/bin/env python3
"""Schedule a single offline update before GNOME starts, without root or reloads."""
import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

UNIT = 'liquid-glass-next-boot.service'
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
PARTS = ('install.sh', 'config', 'extensions', 'themes', 'fonts', 'widgets', 'assets', 'scripts')
DCONF = ('/org/gnome/desktop/interface/', '/org/gnome/desktop/wm/preferences/',
         '/org/gnome/shell/')


def command(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def unit_text(runner, state):
    # systemd has its own argument quoting and expands percent specifiers.
    def quote(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    return f'''[Unit]
Description=Apply Liquid Glass once before the next GNOME session
Before=graphical-session-pre.target gnome-session-manager.target org.gnome.Shell@user.service
After=dbus.socket
ConditionPathExists=!{str(state / 'attempted').replace('%', '%%')}

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {quote(runner)} --run {quote(state)}
TimeoutStartSec=300
ExecStopPost=/usr/bin/python3 {quote(runner)} --interrupted {quote(state)}
UMask=0077

[Install]
WantedBy=graphical-session-pre.target
'''


def prepare_schedule(state, repo):
    if os.geteuid() == 0:
        raise RuntimeError('Ejecutá como tu usuario, sin sudo.')
    if state.exists():
        raise RuntimeError(f'Ya existe una programación: {state}. Revisá --status o usá --cancel primero.')
    user_units = Path.home() / '.config/systemd/user'
    unit = user_units / UNIT
    if unit.exists() or unit.is_symlink():
        raise RuntimeError(f'La unidad ya existe: {unit}')
    for part in PARTS:
        if not (repo / part).exists():
            raise RuntimeError(f'Falta el componente {part}.')
    state.mkdir(parents=True, mode=0o700)
    payload = state / 'payload'
    payload.mkdir()
    for part in PARTS:
        source = repo / part
        if source.is_dir():
            shutil.copytree(source, payload / part, symlinks=True,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        else:
            shutil.copy2(source, payload / part)
    targets = []
    schemas = command('gsettings', 'list-schemas', capture_output=True, text=True).stdout.splitlines()
    if 'org.gnome.Ptyxis' in schemas:
        targets.append('ptyxis')
    if shutil.which('ghostty'):
        targets.append('ghostty')
    if shutil.which('brave-browser') or shutil.which('brave'):
        targets.append('brave')
    for target in targets:
        command('bash', str(payload / 'scripts/configure-app-themes.sh'), target,
                capture_output=True, text=True)
    (state / 'plan.json').write_text(json.dumps({
        'boot_id': BOOT_ID.read_text().strip(), 'targets': targets,
        'status': 'pending',
    }, indent=2) + '\n')
    user_units.mkdir(parents=True, exist_ok=True)
    unit.write_text(unit_text(payload / 'scripts/next-boot-update.py', state))
    command('systemctl', '--user', 'daemon-reload')
    # Never --now: the current desktop must remain untouched.
    command('systemctl', '--user', 'enable', UNIT)
    print(f'Programado para el próximo arranque. Temas: {", ".join(targets) or "ninguno instalado"}.')
    print(f'Estado y respaldo: {state}')


def schedule(state, repo):
    unit = Path.home() / '.config/systemd/user' / UNIT
    # Do not clean up anything owned by an earlier schedule.
    if state.exists() or unit.exists() or unit.is_symlink():
        raise RuntimeError('Ya existe una programación. Revisá --status o usá --cancel primero.')
    try:
        prepare_schedule(state, repo)
    except Exception:
        if unit.exists():
            subprocess.run(['systemctl', '--user', 'disable', UNIT], capture_output=True)
            unit.unlink()
            subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True)
        if state.exists():
            shutil.rmtree(state)
        raise


def run(state):
    plan = json.loads((state / 'plan.json').read_text())
    if BOOT_ID.read_text().strip() == plan['boot_id']:
        print('Todavía es el mismo arranque; no se aplica ningún cambio.')
        return
    if (state / 'attempted').exists():
        print('La aplicación ya se intentó; no se repetirá automáticamente.')
        return
    shell = subprocess.run(['systemctl', '--user', 'is-active', 'org.gnome.Shell@user.service'],
                           capture_output=True, text=True)
    if shell.returncode == 0 or shell.stdout.strip() in ('active', 'activating', 'reloading'):
        raise RuntimeError('GNOME ya está activo; se conserva la programación para otra entrada segura.')
    if shell.returncode not in (3, 4):
        raise RuntimeError('No se pudo comprobar que GNOME esté detenido; no se aplica nada.')
    # Claim the attempt before making changes. A failed update never loops on login.
    with (state / 'attempted').open('x') as handle:
        handle.write(BOOT_ID.read_text())
    plan['status'] = 'applying'
    (state / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    log_path = state / 'apply.log'
    with log_path.open('w') as log:
        try:
            backup = state / 'backup'
            backup.mkdir()
            paths = ['.config/gtk-4.0', '.local/share/glib-2.0/schemas',
                     '.local/share/fonts/SF-Pro', '.local/bin/spotify-glass-widget',
                     '.local/bin/liquid-live-wallpaper',
                     '.local/share/applications/spotify-glass-widget.desktop',
                     '.config/systemd/user/spotify-glass-widget.service',
                     '.config/systemd/user/default.target.wants/spotify-glass-widget.service']
            payload = state / 'payload'
            paths += ['.themes/' + p.name for p in (payload / 'themes').glob('WhiteSur-Dark*')]
            paths += ['.local/share/gnome-shell/extensions/' + p.name
                      for p in (payload / 'extensions').iterdir() if p.is_dir()]
            paths.append('.local/share/flatpak/overrides/global')
            for name in paths:
                source, destination = Path.home() / name, backup / name
                if source.exists() or source.is_symlink():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if source.is_dir() and not source.is_symlink():
                        shutil.copytree(source, destination, symlinks=True)
                    else:
                        shutil.copy2(source, destination, follow_symlinks=False)
            for index, prefix in enumerate(DCONF):
                dump = command('dconf', 'dump', prefix, capture_output=True).stdout
                (backup / f'dconf-{index}.ini').write_bytes(dump)
            # Retain the user's island settings while installing new defaults/schema.
            island = command('dconf', 'dump', '/org/gnome/shell/extensions/liquid-island/',
                             capture_output=True).stdout
            enabled = ast.literal_eval(command('gsettings', 'get', 'org.gnome.shell',
                                               'enabled-extensions', capture_output=True,
                                               text=True).stdout.removeprefix('@as '))
            if not isinstance(enabled, list) or any(not isinstance(x, str) for x in enabled):
                raise RuntimeError('Lista de extensiones previas inválida.')
            legacy = Path.home() / '.config/systemd/user/spotify-glass-widget.service'
            if legacy.is_file():
                # This happens only at boot, before the old graphical widget can start.
                command('systemctl', '--user', 'disable', '--now', 'spotify-glass-widget.service',
                        stdout=log, stderr=log)
            command('bash', str(payload / 'install.sh'), '--offline', stdout=log, stderr=log)
            if island:
                command('dconf', 'load', '/org/gnome/shell/extensions/liquid-island/', input=island,
                        stdout=log, stderr=log)
            installed = ast.literal_eval(command('gsettings', 'get', 'org.gnome.shell',
                                                 'enabled-extensions', capture_output=True,
                                                 text=True).stdout.removeprefix('@as '))
            command('gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
                    repr(list(dict.fromkeys(enabled + installed))), stdout=log, stderr=log)
            for target in plan['targets']:
                command('bash', str(payload / 'scripts/configure-app-themes.sh'), target, '--apply',
                        stdout=log, stderr=log)
            plan['status'] = 'done'
            log.write('\nActualización completada. Brave: cargar el tema manualmente desde extensiones.\n')
        except Exception as error:
            plan['status'] = 'failed'
            log.write(f'\nERROR: {error}\nRespaldo: {state / "backup"}\n')
            raise
        finally:
            (state / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')


def interrupted(state):
    path = state / 'plan.json'
    plan = json.loads(path.read_text())
    if plan['status'] == 'applying':
        plan['status'] = 'failed'
        plan['error'] = 'Proceso interrumpido o timeout; consultar apply.log y journalctl --user -u ' + UNIT
        path.write_text(json.dumps(plan, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path,
                        default=Path.home() / '.local/state/liquid-glass-linux/next-boot')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--run', type=Path, help=argparse.SUPPRESS)
    mode.add_argument('--interrupted', type=Path, help=argparse.SUPPRESS)
    mode.add_argument('--status', action='store_true')
    mode.add_argument('--cancel', action='store_true')
    args = parser.parse_args()
    args.state = args.state.expanduser().absolute()
    if any(char in str(args.state) for char in ('\n', '\r', '\x00')):
        parser.error('Ruta de estado inválida.')
    if args.run:
        run(args.run)
    elif args.interrupted:
        interrupted(args.interrupted)
    elif args.status:
        print((args.state / 'plan.json').read_text() if (args.state / 'plan.json').exists()
              else 'No hay actualización programada.')
    elif args.cancel:
        command('systemctl', '--user', 'disable', UNIT)
        unit = Path.home() / '.config/systemd/user' / UNIT
        unit.unlink(missing_ok=True)
        command('systemctl', '--user', 'daemon-reload')
        # Keep logs and backups; never delete them during cancellation.
        archive = args.state.with_name(args.state.name + '.cancelled-' + str(time.time_ns()))
        if args.state.exists():
            args.state.rename(archive)
        print(f'Programación cancelada. Los archivos y respaldos siguen en {archive}.')
    else:
        schedule(args.state, Path(__file__).resolve().parent.parent)


if __name__ == '__main__':
    try:
        os.umask(0o077)
        main()
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
