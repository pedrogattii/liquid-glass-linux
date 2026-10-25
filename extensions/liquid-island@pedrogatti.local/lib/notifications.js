import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Lifetime} from './lifecycle.js';
import {canPresent} from './policy.js';

export class Notifications {
    constructor({present, changed, hidden, suppress}) {
        this.life = new Lifetime();
        this.sourceLives = new Map();
        this.present = present;
        this.changed = changed;
        this.hidden = hidden;
        this.settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.life.connect(this.settings, 'changed::show-banners', () => {
            if (!this.settings.get_boolean('show-banners'))
                suppress();
        });
        this.suppress = suppress;
        this.injections = new InjectionManager();
        Main.messageTray.bannerBlocked = true;
        const tray = Main.messageTray;
        for (const source of tray.getSources())
            this.watch(source);
        this.life.connect(tray, 'source-added', (_tray, source) => this.watch(source));
        this.life.connect(tray, 'source-removed', (_tray, source) => {
            this.sourceLives.get(source)?.destroy();
            this.sourceLives.delete(source);
            this.changed();
        });
        const controller = this;
        // GNOME 50 adapter: the original handler already applies application
        // policy and priority. Consume only its pending banners, not the stored
        // notifications. No competing org.freedesktop.Notifications daemon.
        this.injections.overrideMethod(tray, '_updateState', original => function (...args) {
            const pending = this._notificationQueue.splice(0);
            const result = original.apply(this, args);
            for (const notification of pending)
                controller.receive(notification);
            if (pending.length)
                this.emit('queue-changed');
            return result;
        });

        // Unify notifications into Dynamic Island: hide duplicate list and indicator from dateMenu
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu?._messageList) {
            dateMenu._messageList.hide();
            this.injections.overrideMethod(dateMenu, '_sessionUpdated', original => function (...args) {
                original.apply(this, args);
                this._messageList.hide();
            });
        }
        if (dateMenu?._indicator)
            dateMenu._indicator.hide();
    }

    watch(source) {
        if (this.sourceLives.has(source))
            return;
        const life = new Lifetime();
        this.sourceLives.set(source, life);
        life.connect(source.policy, 'notify', () => {
            if (!source.policy.enable || !source.policy.showBanners)
                this.suppress(source);
        });
        life.connect(source, 'notification-added', () => this.changed());
        life.connect(source, 'notification-removed', () => this.changed());
        // Includes updates to an existing resident notification.
        life.connect(source, 'notification-request-banner', () => this.changed());
        this.changed();
    }

    receive(notification) {
        if (!this.life.alive)
            return;
        const policy = notification.source.policy;
        const eligible = () => canPresent({
            hidden: this.hidden(), dnd: !this.settings.get_boolean('show-banners'),
            enabled: policy.enable, banners: policy.showBanners,
            urgency: notification.urgency,
        });
        if (!eligible()) {
            this.changed();
            return;
        }
        this.present(notification, () => {
            if (!eligible())
                return false;
            notification.acknowledged = true;
            if (notification.source?.policy?.playSound !== false)
                notification.playSound?.();
            return true;
        });
        this.changed();
    }

    list() {
        return Main.messageTray.getSources().flatMap(source => source.notifications)
            .filter(n => !n._destroyed && n.source.policy.enable)
            .sort((a, b) => b.datetime.to_unix() - a.datetime.to_unix());
    }

    clearAll() {
        for (const source of Main.messageTray.getSources()) {
            const notifications = [...source.notifications];
            for (const n of notifications) {
                try {
                    if (!n._destroyed && !n.resident && n.isClearable?.() !== false)
                        n.destroy();
                } catch (e) {
                    console.debug(e);
                }
            }
        }
        this.changed();
    }

    destroy() {
        Main.messageTray.bannerBlocked = false;
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu?._messageList)
            dateMenu._messageList.visible = Main.sessionMode.hasNotifications && !Main.sessionMode.isGreeter;
        if (dateMenu?._indicator)
            dateMenu._indicator.show();

        this.injections.clear();
        this.life.destroy();
        for (const life of this.sourceLives.values())
            life.destroy();
        this.sourceLives.clear();
        this.settings = null;
    }
}
