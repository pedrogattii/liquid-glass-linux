// Test extension loaded only into the guarded, private headless Shell.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'liquid-island@pedrogatti.local';
const BUS = 'org.mpris.MediaPlayer2.liquid_test';
const OUTPUT = '/tmp/liquid-shell-smoke.json';
function guarded() {
    const runtime = GLib.getenv('XDG_RUNTIME_DIR') ?? '';
    const base = runtime.replace(/\/runtime$/, '');
    if (GLib.getenv('LIQUID_ISOLATED_TEST') !== '1' ||
        !/^\/tmp\/liquid-shell-test\.[A-Za-z0-9]+\/runtime$/.test(runtime) ||
        ['CONFIG', 'DATA', 'CACHE', 'STATE'].some(kind =>
            GLib.getenv(`XDG_${kind}_HOME`) !== `${base}/${kind.toLowerCase()}`) ||
        GLib.getenv('GSETTINGS_BACKEND') !== 'keyfile' ||
        GLib.getenv('WAYLAND_DISPLAY') !== 'liquid-test-wayland')
        throw new Error('Shell probe requires the isolated /tmp/liquid-shell-test.* compositor');
    const path = Main.extensionManager.lookup(UUID)?.dir.get_path();
    if (!path?.startsWith(`${base}/data/gnome-shell/extensions/`))
        throw new Error('Target extension is not inside the isolated test data directory');
}
const check = (condition, message) => { if (!condition) throw new Error(message); };
export default class ShellProbe extends Extension {
    enable() {
        guarded();
        this.alive = true;
        this.sources = new Map();
        this.result = {passed: false, complete: false, checks: [], error: null};
        this.delay(5000).then(() => this.run()).catch(error => this.finish(error));
    }
    delay(ms) {
        return new Promise((resolve, reject) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this.sources.delete(id);
                if (this.alive) resolve();
                else reject(new Error('Probe disabled before completion'));
                return GLib.SOURCE_REMOVE;
            });
            this.sources.set(id, reject);
        });
    }
    async until(predicate, description, timeout = 8000) {
        const end = GLib.get_monotonic_time() + timeout * 1000;
        while (this.alive && GLib.get_monotonic_time() < end) {
            if (predicate()) return;
            await this.delay(50);
        }
        throw new Error(`Timed out: ${description}`);
    }
    target() { return Main.extensionManager.lookup(UUID)?.stateObj; }
    write() { GLib.file_set_contents(OUTPUT, JSON.stringify(this.result, null, 2)); }
    finish(error = null) {
        if (this.finished) return;
        this.finished = true;
        this.result.complete = true;
        this.result.passed = !error;
        this.result.error = error ? `${String(error)}\n${error.stack ?? ''}` : null;
        this.write();
        console.log(`Liquid isolated probe: ${error ? 'FAILED' : 'PASSED'} (${this.result.checks.length} checks)`);
    }
    async hideOverview() {
        Main.overview.hide();
        await this.until(() => !Main.overview.visible && !Main.overview.animationInProgress,
            'overview completely hidden');
        await this.delay(80);
    }
    async step(name, callback) {
        await this.hideOverview();
        try {
            await callback();
            this.result.checks.push({name, passed: true});
        } catch (error) {
            this.result.checks.push({name, passed: false, error: String(error)});
            throw error;
        } finally {
            this.write();
            await this.hideOverview();
        }
    }
    async key(handle, key, shift = false) {
        const {widgets, settings} = this.target();
        const record = [...widgets.records.values()].find(item => item.grip === handle || item.resize === handle);
        const describe = actor => actor ? `${actor.constructor.name}:${actor.name ?? ''}:${actor.accessible_name ?? ''}` : null;
        const snapshot = () => ({rect: {...record.rect}, edit: settings.get_boolean('widgets-edit-mode'),
            focus: describe(global.stage.get_key_focus()), grab: describe(global.stage.get_grab_actor()),
            focusWindow: global.display.focus_window?.get_title() ?? null,
            mapped: handle.mapped, visible: handle.visible, reactive: handle.reactive,
            actionMode: Main.actionMode, overview: Main.overview.visible});
        const trace = {key, shift, before: snapshot(), stageEvents: [], handleEvents: [], handlerCalls: []};
        this.result.keyboardDiagnostics ??= [];
        this.result.keyboardDiagnostics.push(trace);
        const stageSignal = global.stage.connect('captured-event', (_actor, event) => {
            if ([Clutter.EventType.KEY_PRESS, Clutter.EventType.KEY_RELEASE].includes(event.type()))
                trace.stageEvents.push({type: event.type(), key: event.get_key_symbol(), state: event.get_state(),
                    time: event.get_time(), source: describe(global.stage.get_event_actor(event)), focus: describe(global.stage.get_key_focus())});
            return Clutter.EVENT_PROPAGATE;
        });
        const handleSignal = handle.connect('captured-event', (_actor, event) => {
            if ([Clutter.EventType.KEY_PRESS, Clutter.EventType.KEY_RELEASE].includes(event.type()))
                trace.handleEvents.push({type: event.type(), key: event.get_key_symbol(), state: event.get_state()});
            return Clutter.EVENT_PROPAGATE;
        });
        const original = widgets.keyGesture;
        widgets.keyGesture = function (item, event, resize) {
            const call = {key: event.get_key_symbol(), state: event.get_state(), resize, before: {...item.rect}};
            trace.handlerCalls.push(call);
            const result = original.call(this, item, event, resize);
            call.after = {...item.rect};
            call.result = result;
            return result;
        };
        const keyboard = this.keyboard;
        const send = (symbol, state) => keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, state);
        try {
            handle.grab_key_focus();
            await this.delay(120);
            trace.focused = snapshot();
            check(global.stage.get_key_focus() === handle, 'Widget handle did not receive keyboard focus');
            if (shift) {
                send(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
                await this.delay(50);
            }
            send(key, Clutter.KeyState.PRESSED);
            await this.delay(160);
        } finally {
            send(key, Clutter.KeyState.RELEASED);
            if (shift) send(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            await this.delay(200);
            trace.after = snapshot();
            trace.savedLayout = settings.get_string('widget-layout');
            widgets.keyGesture = original;
            global.stage.disconnect(stageSignal);
            handle.disconnect(handleSignal);
            this.write();
        }
    }
    async callRoot(method) {
        await new Promise((resolve, reject) => Gio.DBus.session.call(BUS, '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2', method, null, null, Gio.DBusCallFlags.NO_AUTO_START,
            3000, null, (bus, result) => {
                try { bus.call_finish(result); resolve(); } catch (error) { reject(error); }
            }));
    }
    async run() {
        try {
            guarded();
            await this.until(() => Main.extensionManager.lookup(UUID)?.state === ExtensionState.ACTIVE &&
                this.target()?.widgets?.records.size === 12, 'all twelve native widgets');
            const order = Main.extensionManager._extensionOrder;
            check(order.indexOf(this.uuid) >= 0 && order.indexOf(this.uuid) < order.indexOf(UUID),
                'Enable probe BEFORE Liquid Island to keep extension rebase from disabling the probe');
            this.keyboard = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            await this.step('twelve-real-widget-actors', async () => {
                const widgets = this.target().widgets;
                check(widgets.layer.get_parent() === Main.layoutManager._backgroundGroup, 'Widgets are not in desktop background group');
                check(widgets.records.size === 12 && widgets.layer.get_n_children() === 12, 'Expected twelve widget actors');
                for (const record of widgets.records.values())
                    check(record.actor.get_stage() === global.stage && record.rect.width > 0, `${record.type} has no real Shell actor/allocation`);
            });
            await this.step('dock-four-edges-and-intellihide-off', async () => {
                const {desktop, settings} = this.target();
                const original = desktop.isAppOpen;
                try {
                    desktop.isAppOpen = () => false;
                    for (const edge of ['bottom', 'top', 'left', 'right']) {
                        settings.set_string('dock-position', edge);
                        await this.delay(180);
                        desktop.updateVisibility(false);
                        const monitor = Main.layoutManager.primaryMonitor;
                        const trigger = desktop.geometry.trigger;
                        check(desktop.dock.visible, `${edge} dock is hidden`);
                        check(desktop.row.orientation === (['left', 'right'].includes(edge)
                            ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL), `${edge} dock orientation`);
                        check(desktop.dock.x >= monitor.x && desktop.dock.y >= monitor.y &&
                            desktop.dock.x + desktop.dock.width <= monitor.x + monitor.width + 1 &&
                            desktop.dock.y + desktop.dock.height <= monitor.y + monitor.height + 1, `${edge} dock outside monitor`);
                        check(edge === 'left' ? trigger.x === monitor.x : edge === 'right'
                            ? trigger.x + trigger.width === monitor.x + monitor.width : edge === 'top'
                                ? trigger.y === monitor.y + Main.panel.height
                                : trigger.y + trigger.height === monitor.y + monitor.height, `${edge} edge trigger position`);
                    }
                    desktop.isAppOpen = () => true;
                    settings.set_boolean('dock-intellihide', false);
                    desktop.updateVisibility(false);
                    await this.delay(350);
                    check(desktop.dock.visible && desktop.dock.opacity === 255, 'Turning intellihide off must keep dock visible with an open app');
                } finally {
                    desktop.isAppOpen = original;
                    settings.set_string('dock-position', 'bottom');
                    settings.set_boolean('dock-intellihide', true);
                    desktop.updateVisibility(false);
                }
            });
            await this.step('widget-real-keyboard-move-resize-save-reset', async () => {
                const {widgets, settings} = this.target();
                settings.set_boolean('widgets-edit-mode', true);
                settings.reset('widget-layout');
                await this.delay(100);
                const record = widgets.records.get('clock');
                const initial = {...record.rect};
                await this.key(record.grip, Clutter.KEY_Right);
                check(record.rect.x > initial.x, 'Arrow key did not move clock');
                check(JSON.parse(settings.get_string('widget-layout')).widgets.clock.x === record.rect.x, 'Key release did not save moved clock');
                const width = record.rect.width;
                await this.key(record.grip, Clutter.KEY_Right, true);
                check(record.rect.width > width, 'Shift+arrow did not resize clock');
                check(JSON.parse(settings.get_string('widget-layout')).widgets.clock.width === record.rect.width, 'Key release did not save resized clock');
                settings.reset('widget-layout');
                await this.delay(100);
                check(record.rect.x === initial.x && record.rect.width === initial.width, 'Layout reset did not restore clock geometry');
            });
            await this.step('module-order-moves-real-containers', async () => {
                const {island, settings} = this.target();
                const names = ['calendar', 'telemetry', 'quick', 'music', 'notifications'];
                settings.set_strv('island-module-order', names);
                await this.delay(100);
                const children = island.content.get_children();
                let last = 1;
                for (const name of names) {
                    for (const actor of island.moduleActors[name]) {
                        const index = children.indexOf(actor);
                        check(index > last, `${name} container did not move to requested order`);
                        last = index;
                    }
                }
                settings.reset('island-module-order');
            });
            await this.step('overview-during-popup-dismissal-clears-surface', async () => {
                const {island, widgets} = this.target();
                island.close(false);
                island.toggle();
                await this.delay(80);
                island.close(true);
                check(island.closing && Boolean(island.root.get_transition('opacity')),
                    'Private Shell must enable animations to exercise the dismissal race');
                Main.overview.show();
                await this.until(() => Main.overview.visible && !widgets.layer.visible, 'overview hides desktop widgets');
                await this.delay(450);
                check(!island.root.visible && !island.backdrop.actor.visible && !island.backdrop.pipeline,
                    'Overview retained popup surface or backdrop capture');
                check(!island.expanded && !island.closing, 'Overview retained popup animation state');
                await this.hideOverview();
                check(!island.root.visible, 'Stale dismissal reopened popup after overview');
            });
            await this.step('mpris-paused-play-pause-quit-real-dbus', async () => {
                const extension = this.target();
                const {music, island, widgets, settings} = extension;
                settings.set_boolean('widgets-edit-mode', false);
                settings.set_boolean('music-show-widget', true);
                settings.set_boolean('music-show-island', true);
                await this.until(() => music.state.name === BUS && music.state.connected, 'paused fixture MPRIS proxy');
                check(music.state.present && !music.state.playing, 'Paused fixture is not persistently present');
                check(island.musicChip.visible && island.player.visible && widgets.records.get('music').actor.visible,
                    'Paused fixture is missing chip/card/widget');
                island.toggle();
                await this.delay(100);
                check(island.root.visible && island.player.mapped, 'Paused expanded music card is not mapped');
                music.command('Play');
                await this.until(() => music.state.playing, 'MPRIS Play reflected by service');
                music.command('Pause');
                await this.until(() => !music.state.playing && music.state.present, 'MPRIS Pause retains presence');
                check(widgets.records.get('music').actor.visible && island.musicChip.visible, 'Pausing hid music UI');
                island.close(false);
                await this.callRoot('Quit');
                await this.until(() => !music.state.present && !widgets.records.get('music').actor.visible,
                    'MPRIS owner exit hides music widget');
                check(!island.musicChip.visible && !island.player.visible, 'Exited fixture retained island music UI');
                settings.set_boolean('widgets-edit-mode', true);
            });
            for (let cycle = 1; cycle <= 2; cycle++) {
                await this.step(`disable-enable-cleans-resources-${cycle}`, async () => {
                    const old = this.target();
                    const owners = [old.island, old.desktop, old.widgets, old.music, old.telemetry, old.notifications];
                    const widgets = old.widgets;
                    const providers = widgets.providers;
                    const music = old.music;
                    const destroyed = new Set();
                    for (const [name, actor] of [['island', old.island.root], ['dock', old.desktop.dock],
                        ['trigger', old.desktop.edgeTrigger], ['widgets', widgets.layer]])
                        actor.connect('destroy', () => destroyed.add(name));
                    check(Main.extensionManager.disableExtension(UUID), 'Manager rejected isolated disable');
                    await this.until(() => Main.extensionManager.lookup(UUID).state === ExtensionState.INACTIVE, 'isolated extension disable');
                    check(destroyed.size === 4, 'Disable retained chrome or widget actors');
                    for (const owner of owners)
                        check(!owner.life.alive && owner.life.signals.length === 0 && owner.life.sources.size === 0, 'Disable retained lifetime signals/sources');
                    check(widgets.records.size === 0 && providers.cancel.is_cancelled() && music.listeners.size === 0 && music.nameSignal === 0,
                        'Disable retained widget records, provider requests, or MPRIS subscriptions');
                    check(Main.extensionManager.enableExtension(UUID), 'Manager rejected isolated enable');
                    await this.until(() => Main.extensionManager.lookup(UUID).state === ExtensionState.ACTIVE &&
                        this.target().widgets?.records.size === 12, 'isolated extension re-enable');
                    const layers = Main.layoutManager._backgroundGroup.get_children().filter(actor => actor.name === 'liquid-native-widgets');
                    check(layers.length === 1, 'Re-enable created duplicate desktop widget layers');
                });
            }
            this.keyboard = null;
            this.finish();
        } catch (error) {
            this.keyboard = null;
            this.finish(error);
        }
    }
    disable() {
        this.alive = false;
        for (const [id, reject] of this.sources ?? []) {
            GLib.source_remove(id);
            reject(new Error('Probe disabled before completion'));
        }
        this.sources?.clear();
        this.keyboard = null;
    }
}
