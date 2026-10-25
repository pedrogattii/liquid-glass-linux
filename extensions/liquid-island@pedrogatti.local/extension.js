import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Island} from './lib/island.js';
import {Music} from './lib/music.js';
import {Notifications} from './lib/notifications.js';
import {SystemEvents} from './lib/system.js';
import {LegacyWidget} from './lib/legacy.js';
import {Desktop} from './lib/desktop.js';

export default class LiquidIsland extends Extension {
    enable() {
        try {
            this.settings = this.getSettings();
            this.island = new Island(this.settings, () => this.openPreferences());
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
            this.desktop = new Desktop(this.settings, () => this.island.hidden());
            this.legacy = new LegacyWidget(this.settings, () => Boolean(this.island?.root.get_stage()));
            console.log('Liquid Island: ready');
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        Main.wm.removeKeybinding('toggle-island');
        this.legacy?.destroy();
        this.system?.destroy();
        this.desktop?.destroy();
        this.notifications?.destroy();
        this.music?.destroy();
        this.island?.destroy();
        this.system = this.notifications = this.music = this.island = this.settings = null;
        this.legacy = null;
        this.desktop = null;
    }
}
