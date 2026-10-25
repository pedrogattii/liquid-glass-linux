import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Island} from './lib/island.js';
import {Music} from './lib/music.js';
import {Notifications} from './lib/notifications.js';
import {SystemEvents} from './lib/system.js';
import {LegacyWidget} from './lib/legacy.js';
import {Desktop} from './lib/desktop.js';
import {Telemetry} from './lib/telemetry.js';
import {Widgets} from './lib/widgets.js';

export default class LiquidIsland extends Extension {
    enable() {
        try {
            this.settings = this.getSettings();
            this.widgetTheme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            this.widgetStylesheet = this.dir.get_child('widgets.css');
            this.widgetTheme.load_stylesheet(this.widgetStylesheet);
            this.island = new Island(this.settings, () => this.openPreferences());
            this.telemetry = new Telemetry(state => {
                this.island?.updateTelemetry(state);
                this.widgets?.setTelemetry(state);
            });
            this.island.telemetry = this.telemetry;
            this.music = new Music(() => this.island?.updateMusic());
            this.island.music = this.music;
            this.notifications = new Notifications({
                present: (notification, onPresent) => this.island.notification(notification, onPresent),
                changed: () => this.island.historyChanged(), hidden: () => this.island.hidden(),
                suppress: source => this.island.suppressAlerts(source),
            });
            this.island.notifications = this.notifications;
            this.system = new SystemEvents(event => this.island.systemEvent(event), () => this.island.hidden());
            Main.wm.addKeybinding('toggle-island', this.settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => this.island.toggle());
            this.island.updateMusic();
            this.desktop = new Desktop(this.settings, () => this.island.hidden(), () => this.openPreferences());
            this.widgets = new Widgets(this.settings, {
                music: this.music, telemetry: this.telemetry, interfaceSettings: this.island.interface, wallClock: this.island.wallClock, openPreferences: () => this.openPreferences(),
            });
            Main.wm.addKeybinding('toggle-widget-edit', this.settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => this.settings.set_boolean('widgets-edit-mode',
                    !this.settings.get_boolean('widgets-edit-mode')));
            this.legacy = new LegacyWidget(this.settings, () => Boolean(this.island?.root.get_stage()));
            console.debug('Liquid Island: ready');
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        Main.wm.removeKeybinding('toggle-island');
        Main.wm.removeKeybinding('toggle-widget-edit');
        this.widgets?.destroy();
        this.widgets = null;
        this.telemetry?.destroy();
        this.legacy?.destroy();
        this.system?.destroy();
        this.desktop?.destroy();
        this.notifications?.destroy();
        this.music?.destroy();
        this.island?.destroy();
        this.system = this.notifications = this.music = this.island = this.settings = null;
        this.telemetry = null;
        this.legacy = null;
        this.desktop = null;
        if (this.widgetStylesheet)
            this.widgetTheme?.unload_stylesheet(this.widgetStylesheet);
        this.widgetStylesheet = this.widgetTheme = null;
    }
}
