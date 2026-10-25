#!/usr/bin/env python3
"""Exercise deferred updates entirely in temporary directories with mocked commands."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('boot_update',
    Path(__file__).resolve().parents[1] / 'scripts/next-boot-update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class BootUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'user'
        self.home.mkdir()
        self.addCleanup(patch.stopall)
        patch.object(Path, 'home', return_value=self.home).start()
        patch.object(update.os, 'geteuid', return_value=1000).start()
        self.boot = self.root / 'boot-id'
        self.boot.write_text('boot-new')
        patch.object(update, 'BOOT_ID', self.boot).start()
        self.state = self.home / '.local/state/update'
        self.state.mkdir(parents=True)
        self.payload = self.state / 'payload'
        (self.payload / 'themes').mkdir(parents=True)
        (self.payload / 'extensions').mkdir()
        self.plan('boot-old')

    def plan(self, boot, targets=()):
        (self.state / 'plan.json').write_text(json.dumps({
            'boot_id': boot, 'targets': list(targets), 'status': 'pending'}))

    def command(self, *args, **kwargs):
        if args[:2] == ('gsettings', 'get'):
            names = ['third-party@test'] if not self.installed else ['liquid-island@test']
            return subprocess.CompletedProcess(args, 0, repr(names))
        if args[:2] == ('dconf', 'dump'):
            return subprocess.CompletedProcess(args, 0, b'')
        if args[0] == 'bash' and args[-1] == '--offline':
            self.installed = True
        return subprocess.CompletedProcess(args, 0, '')

    def simulate(self):
        self.installed = False
        patch.object(update.subprocess, 'run', return_value=
                     subprocess.CompletedProcess([], 3, 'inactive')).start()
        return patch.object(update, 'command', side_effect=self.command).start()

    def test_same_boot_never_contacts_session_or_installs(self):
        self.plan('boot-new')
        with patch.object(update, 'command') as command, patch.object(update.subprocess, 'run') as run:
            update.run(self.state)
            command.assert_not_called()
            run.assert_not_called()
        self.assertFalse((self.state / 'attempted').exists())

    def test_running_shell_is_never_updated(self):
        with patch.object(update.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 0, 'active')):
            with self.assertRaisesRegex(RuntimeError, 'GNOME ya está activo'):
                update.run(self.state)
        self.assertFalse((self.state / 'attempted').exists())

    def test_future_boot_merges_extensions_and_runs_once(self):
        command = self.simulate()
        update.run(self.state)
        self.assertEqual(json.loads((self.state / 'plan.json').read_text())['status'], 'done')
        command.assert_any_call('gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
                                "['third-party@test', 'liquid-island@test']",
                                stdout=unittest.mock.ANY, stderr=unittest.mock.ANY)
        command.reset_mock()
        update.run(self.state)
        command.assert_not_called()

    def test_failure_is_recorded_and_never_retried(self):
        command = self.simulate()
        command.side_effect = RuntimeError('simulated failure')
        with self.assertRaisesRegex(RuntimeError, 'simulated failure'):
            update.run(self.state)
        self.assertEqual(json.loads((self.state / 'plan.json').read_text())['status'], 'failed')
        command.reset_mock()
        update.run(self.state)
        command.assert_not_called()

    def test_timeout_marks_incomplete_attempt_as_failed(self):
        path = self.state / 'plan.json'
        path.write_text(json.dumps({'status': 'applying'}))
        update.interrupted(self.state)
        self.assertEqual(json.loads(path.read_text())['status'], 'failed')

    def test_failed_schedule_cleans_only_new_files(self):
        state = self.root / 'new-state'
        def fail_prepare(state, repo):
            state.mkdir()
            raise RuntimeError('copy failed')
        with patch.object(update, 'prepare_schedule', side_effect=fail_prepare):
            with self.assertRaises(RuntimeError):
                update.schedule(state, self.root)
        self.assertFalse(state.exists())
        with self.assertRaises(RuntimeError):
            update.schedule(self.state, self.root)
        self.assertTrue((self.state / 'plan.json').exists())

    def test_unit_runs_before_shell_and_never_starts_via_default_target(self):
        unit = update.unit_text(self.payload / 'runner.py', self.state)
        self.assertIn('org.gnome.Shell@user.service', unit)
        self.assertIn('WantedBy=graphical-session-pre.target', unit)
        self.assertNotIn('WantedBy=default.target', unit)
        self.assertIn('ExecStopPost=', unit)

    def test_scheduling_only_stages_and_enables_without_applying(self):
        repo, state = self.root / 'repo', self.root / 'scheduled'
        repo.mkdir()
        for part in update.PARTS:
            if part == 'install.sh':
                (repo / part).write_text('# fixture')
            else:
                (repo / part).mkdir()
        (repo / 'scripts/next-boot-update.py').write_text('# fixture')
        with patch.object(update.shutil, 'which', return_value=None), patch.object(
                update, 'command', return_value=subprocess.CompletedProcess(
                    [], 0, 'org.gnome.Ptyxis\n')) as command:
            update.schedule(state, repo)
        self.assertTrue((state / 'payload/config').is_dir())
        self.assertEqual(json.loads((state / 'plan.json').read_text())['status'], 'pending')
        command.assert_any_call('systemctl', '--user', 'enable', update.UNIT)
        for call in command.call_args_list:
            self.assertNotIn('--now', call.args)
            self.assertNotIn('--apply', call.args)
            self.assertNotIn('dconf', call.args)


if __name__ == '__main__':
    unittest.main()
