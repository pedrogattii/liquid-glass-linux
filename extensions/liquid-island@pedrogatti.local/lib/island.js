import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Lifetime} from './lifecycle.js';
import {plainText} from './policy.js';
import {Backdrop} from './backdrop.js';

function label(text = '', style = 'liquid-subtitle') {
    const actor = new St.Label({text, style_class: style,
        y_align: Clutter.ActorAlign.CENTER, x_expand: true});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function button(icon, name, action, style = 'liquid-control') {
    const actor = new St.Button({style_class: style, can_focus: true,
        accessible_name: name, child: new St.Icon({icon_name: icon, icon_size: 18})});
    actor.connect('clicked', action);
    return actor;
}

function time(us) {
    const seconds = Math.max(0, Math.floor(us / 1000000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export class Island {
    constructor(settings, openPreferences) {
        this.life = new Lifetime();
        this.settings = settings;
        this.interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.openPreferences = openPreferences;
        this.expanded = false;
        this.queue = [];
        this.current = null;
        this.event = null;
        this.music = null;
        this.notifications = null;
        this.tickId = 0;
        this.waveStep = 0;
        this.root = new St.Widget({style_class: 'liquid-island',
            layout_manager: new Clutter.BinLayout(), reactive: true,
            clip_to_allocation: true});
        this.surface = new St.BoxLayout({style_class: 'liquid-surface liquid-compact',
            orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.root.add_child(this.surface);
        this.backdrop = new Backdrop(this.root, settings);
        this.build();
        this.panelButton = new PanelMenu.Button(0.5, 'Liquid Island', true);
        this.panelButton.can_focus = false;
        this.panelButton.add_style_class_name('liquid-panel-media');
        this.panelButton.add_child(this.compact);
        Main.panel.addToStatusArea('liquidIsland', this.panelButton, 1, 'center');
        Main.layoutManager.addTopChrome(this.root, {affectsStruts: false, trackFullscreen: true});
        this.life.connect(Main.panel._centerBox, 'notify::allocation', () => this.layout());
        for (const role of ['dateMenu', 'quickSettings']) {
            const menu = Main.panel.statusArea[role]?.menu;
            if (menu)
                this.life.connect(menu, 'open-state-changed', (_menu, open) => { if (open) this.close(false); });
        }
        this.life.connect(Main.layoutManager, 'monitors-changed', () => this.visibility());
        this.life.connect(global.display, 'in-fullscreen-changed', () => this.visibility());
        for (const sig of ['showing', 'shown', 'hiding', 'hidden'])
            this.life.connect(Main.overview, sig, () => this.visibility());
        this.life.connect(Main.sessionMode, 'updated', () => this.visibility());
        this.life.connect(Main.panel, 'notify::height', () => this.layout());
        this.life.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => {
            this.appearance();
            this.layout();
        });
        this.life.connect(settings, 'changed', () => this.appearance());
        this.life.connect(this.interface, 'changed::color-scheme', () => this.appearance());
        this.life.connect(this.interface, 'changed::enable-animations', () => this.refreshTicker());
        this.life.connect(global.stage, 'captured-event', (_stage, event) => this.capture(event));
        this.life.connect(this.root, 'notify::hover', () => {
            if (!this.root.hover && this.current && this.current.notification.urgency !== 3)
                this.armPreview();
        });
        this.root.track_hover = true;
        this.appearance();
        this.visibility();
    }

    build() {
        this.compact = new St.Button({can_focus: true, accessible_name: 'Abrir Liquid Island',
            x_expand: true, style_class: 'liquid-compact-button'});
        const row = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
        this.smallCover = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 16,
            style_class: 'liquid-cover'});
        this.compactTitle = label('Liquid Island', 'liquid-title');
        this.wave = label('·', 'liquid-wave');
        this.wave.x_expand = false;
        row.add_child(this.smallCover);
        row.add_child(this.compactTitle);
        row.add_child(this.wave);
        this.compact.set_child(row);
        this.compact.connect('clicked', () => this.toggle());
        this.compact.connect('button-press-event', (_actor, event) => {
            const btn = event.get_button();
            if (btn === 2) {
                this.music?.command('PlayPause');
                return Clutter.EVENT_STOP;
            }
            if (btn === 3) {
                this.music?.command('Next');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Banner preview container (for incoming notifications / system events)
        this.preview = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;', visible: false});
        this.surface.add_child(this.preview);

        // Unified All-in-One container (iOS style: Media + Notifications integrated)
        this.content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 12px; padding: 4px 2px;', visible: false});
        this.surface.add_child(this.content);

        // Top Header Bar
        const header = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
        const headerIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 15,
            style_class: 'liquid-wave'});
        const headerTitle = label('DYNAMIC ISLAND', 'liquid-section');
        header.add_child(headerIcon);
        header.add_child(headerTitle);

        this.clearAllBtn = button('user-trash-symbolic', 'Limpiar todas las notificaciones', () => {
            this.notifications?.clearAll();
        }, 'liquid-aio-action-btn');
        this.clearAllBtn.visible = false;
        header.add_child(this.clearAllBtn);

        const prefsBtn = button('emblem-system-symbolic', 'Preferencias', () => {
            this.close(false);
            this.openPreferences();
        }, 'liquid-aio-action-btn');
        header.add_child(prefsBtn);
        this.content.add_child(header);

        // Media Player Section
        this.player = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 10px;'});
        const song = new St.BoxLayout({style: 'spacing: 14px;'});
        this.cover = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 64,
            style_class: 'liquid-cover'});
        this.coverButton = new St.Button({can_focus: true, accessible_name: 'Abrir Spotify',
            style_class: 'liquid-cover-button', child: this.cover});
        this.coverButton.connect('clicked', () => this.music?.raise());

        const description = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER, x_expand: true, style: 'spacing: 3px;'});
        const tagRow = new St.BoxLayout({style: 'spacing: 6px;'});
        tagRow.add_child(label('SPOTIFY · NOW PLAYING', 'liquid-section liquid-spotify-tag'));
        description.add_child(tagRow);

        this.title = label('Spotify', 'liquid-title liquid-song-title');
        this.titleButton = new St.Button({can_focus: true, accessible_name: 'Abrir Spotify',
            style_class: 'liquid-title-button', child: this.title});
        this.titleButton.connect('clicked', () => this.music?.raise());
        description.add_child(this.titleButton);

        this.artist = label('Esperando reproducción...', 'liquid-artist');
        description.add_child(this.artist);

        this.album = label('', 'liquid-album');
        this.album.visible = false;
        description.add_child(this.album);

        song.add_child(this.coverButton);
        song.add_child(description);
        this.player.add_child(song);

        this.slider = new Slider(0);
        this.slider.add_style_class_name('liquid-meter');
        this.slider.accessible_name = 'Posición de reproducción';
        this.slider.connect('drag-begin', () => { this.dragging = true; });
        this.slider.connect('drag-end', () => {
            this.dragging = false;
            this.music?.seek(this.slider.value);
        });
        this.slider.connect('notify::value', () => {
            if (this.updating || this.dragging)
                return;
            this.life.cancel(this.seekId);
            this.seekId = this.life.after(180, () => this.music?.seek(this.slider.value));
        });
        this.player.add_child(this.slider);

        const times = new St.BoxLayout();
        this.elapsed = label('0:00');
        this.duration = label('0:00');
        this.duration.x_expand = false;
        times.add_child(this.elapsed);
        times.add_child(this.duration);
        this.player.add_child(times);

        const controls = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 14px;'});
        this.previous = button('media-skip-backward-symbolic', 'Anterior', () => this.music?.command('Previous'));
        this.play = button('media-playback-start-symbolic', 'Reproducir', () => this.music?.command('PlayPause'),
            'liquid-control liquid-play');
        this.next = button('media-skip-forward-symbolic', 'Siguiente', () => this.music?.command('Next'));
        this.raiseBtn = button('audio-x-generic-symbolic', 'Abrir Spotify', () => this.music?.raise(),
            'liquid-control liquid-spotify-btn');
        controls.add_child(this.previous);
        controls.add_child(this.play);
        controls.add_child(this.next);
        controls.add_child(this.raiseBtn);
        this.player.add_child(controls);
        this.content.add_child(this.player);

        // Divider
        this.divider = new St.Widget({style_class: 'liquid-divider', x_expand: true});
        this.content.add_child(this.divider);

        // Unified Notifications Section
        const notifHeader = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
        const notifLabel = label('NOTIFICACIONES', 'liquid-section');
        this.notifBadge = new St.Label({text: '0', style_class: 'liquid-badge'});
        notifHeader.add_child(notifLabel);
        notifHeader.add_child(this.notifBadge);
        this.content.add_child(notifHeader);

        this.history = new St.ScrollView({visible: true, x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this.historyBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;', x_expand: true});
        this.history.set_child(this.historyBox);
        this.content.add_child(this.history);
    }

    hidden() {
        const monitor = Main.layoutManager.primaryMonitor;
        const inOverview = Boolean(Main.overview.visible ||
            Main.overview._shown ||
            Main.overview._visibleTarget ||
            Main.overview.animationInProgress);
        return !monitor || inOverview || Main.sessionMode.isLocked ||
            Main.sessionMode.isGreeter || global.display.get_monitor_in_fullscreen(monitor.index);
    }

    visibility() {
        if (this.hidden()) {
            this.close(false);
            this.queue = [];
            this.clearPreview(false);
            this.event = null;
            this.life.cancel(this.eventId);
            this.root.remove_all_transitions();
            this.root.hide();
        } else {
            this.syncPopup();
            this.updateMusic();
            this.layout();
        }
        this.refreshTicker();
    }

    syncPopup() {
        this.root.visible = !this.destroying && !this.hidden() && Boolean(this.expanded || this.current);
    }

    appearance() {
        const appearance = this.settings.get_string('appearance');
        this.dark = appearance === 'dark' || (appearance === 'auto' &&
            this.interface.get_string('color-scheme') === 'prefer-dark');
        for (const actor of [this.root, Main.uiGroup]) {
            actor.remove_style_class_name('liquid-light');
            actor.remove_style_class_name('liquid-dark');
            actor.add_style_class_name(this.dark ? 'liquid-dark' : 'liquid-light');
        }
        if (this.settings.get_boolean('desktop-style'))
            Main.uiGroup.add_style_class_name('liquid-desktop');
        else
            Main.uiGroup.remove_style_class_name('liquid-desktop');
        this.backdrop.update(this.expanded);
    }

    layout(animate = false) {
        if (this.destroying)
            return;
        if (this.hidden() || (!this.expanded && !this.current)) {
            this.root.remove_all_transitions();
            this.root.hide();
            return;
        }
        this.backdrop.update(this.expanded);
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min(410 * scale, monitor.width - 32 * scale);
        this.compact.set_style(`max-width: ${monitor.width < 1200 * scale ? 160 : 240}px;`);
        const [, panelY] = Main.panel.get_transformed_position();
        const [centerX] = Main.panel._centerBox.get_transformed_position();
        const [centerWidth] = Main.panel._centerBox.get_transformed_size();
        const y = panelY + Main.panel.height + 8 * scale;
        this.history.height = Math.max(70 * scale, Math.min(220 * scale,
            monitor.height - Main.panel.height - 280 * scale));
        const height = this.surface.get_preferred_height(width)[1];
        const x = Math.round(Math.max(monitor.x + 12 * scale, Math.min(
            centerX + centerWidth / 2 - width / 2, monitor.x + monitor.width - width - 12 * scale)));
        const target = `${width}:${height}:${x}:${y}`;
        if (target === this.layoutTarget)
            return;
        this.layoutTarget = target;
        this.root.remove_all_transitions();
        this.root.ease({width, height, x, y,
            duration: animate && this.interface.get_boolean('enable-animations') ? 260 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    toggle() {
        if (this.hidden())
            return;
        if (this.expanded) {
            this.close(true);
            return;
        }
        this.savedFocus = global.stage.get_key_focus();
        this.expanded = true;
        this.syncPopup();
        this.life.cancel(this.previewId);
        this.preview.hide();
        this.content.show();
        this.root.add_style_class_name('liquid-expanded');
        this.surface.remove_style_class_name('liquid-compact');
        this.updateMusic();
        this.renderHistory();

        // iOS spring expansion animation
        if (this.interface.get_boolean('enable-animations')) {
            this.root.translation_y = -8;
            this.root.opacity = 0;
            this.layout(false);
            this.root.ease({
                translation_y: 0, opacity: 255,
                duration: 240, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this.layout(false);
        }
        this.music?.refreshPosition();
    }

    close(animate = true) {
        if (!this.expanded)
            return;
        this.expanded = false;
        if (this.savedFocus?.get_stage())
            this.savedFocus.grab_key_focus();
        this.savedFocus = null;

        const finalizeClose = () => {
            this.content.hide();
            this.root.remove_style_class_name('liquid-expanded');
            this.surface.add_style_class_name('liquid-compact');
            this.root.translation_y = 0;
            this.root.opacity = 255;
            if (this.current) {
                this.preview.show();
                this.armPreview();
            }
            this.syncPopup();
            this.layout(false);
            this.nextPreview();
        };

        if (animate && this.root.visible && this.interface.get_boolean('enable-animations')) {
            this.root.remove_all_transitions();
            this.root.ease({
                translation_y: -8, opacity: 0,
                duration: 180, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onStopped: finalizeClose,
            });
        } else {
            finalizeClose();
        }
    }

    capture(event) {
        if (!this.expanded)
            return Clutter.EVENT_PROPAGATE;
        if (event.type() === Clutter.EventType.KEY_PRESS) {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close(true);
                return Clutter.EVENT_STOP;
            }
            if (event.get_key_symbol() === Clutter.KEY_Tab || event.get_key_symbol() === Clutter.KEY_ISO_Left_Tab) {
                this.root.navigate_focus(global.stage.get_key_focus(),
                    event.get_state() & Clutter.ModifierType.SHIFT_MASK ?
                        St.DirectionType.TAB_BACKWARD : St.DirectionType.TAB_FORWARD, true);
                return Clutter.EVENT_STOP;
            }
        }
        if ([Clutter.EventType.BUTTON_PRESS, Clutter.EventType.TOUCH_BEGIN].includes(event.type())) {
            const source = global.stage.get_event_actor(event);
            if (source && !this.root.contains(source) && !this.compact.contains(source))
                this.close(true);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    updateMusic() {
        const state = this.music?.state;
        if (!state)
            return;
        const connected = Boolean(state.connected);
        this.title.text = connected ? plainText(state.title) : 'Spotify';
        this.artist.text = connected ? plainText(state.artist) : 'Sin música en reproducción';
        if (this.album) {
            this.album.text = plainText(state.album);
            this.album.visible = Boolean(state.album && connected);
        }
        for (const actor of this.event ? [this.cover] : [this.smallCover, this.cover]) {
            if (state.cover && actor.gicon !== state.cover)
                actor.gicon = state.cover;
            else if (!state.cover && actor.icon_name !== 'audio-x-generic-symbolic')
                actor.icon_name = 'audio-x-generic-symbolic';
        }
        this.play.child.icon_name = state.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this.play.accessible_name = state.playing ? 'Pausar' : 'Reproducir';
        for (const [actor, enabled] of [[this.play, state.playing ? state.canPause : state.canPlay],
            [this.previous, state.canPrevious], [this.next, state.canNext],
            [this.slider, state.canSeek && state.length > 0],
            [this.raiseBtn, state.connected]]) {
            actor.reactive = Boolean(enabled);
            actor.can_focus = Boolean(enabled);
            if (enabled) actor.remove_style_pseudo_class('insensitive');
            else actor.add_style_pseudo_class('insensitive');
        }
        if (state.playing) {
            this.compact.add_style_class_name('liquid-playing');
            this.root.add_style_class_name('liquid-playing');
        } else {
            this.compact.remove_style_class_name('liquid-playing');
            this.root.remove_style_class_name('liquid-playing');
        }
        if (!this.current && !this.event) {
            const notifCount = this.notifications?.list().length ?? 0;
            this.compactTitle.text = connected ? plainText(state.title) : 'Liquid Island';
            this.compactTitle.visible = true;
            this.wave.text = state.playing ? '▂▅▃' : (notifCount > 0 ? `• ${notifCount}` : '·');
        }
        this.progress();
        this.refreshTicker();
        if (this.expanded)
            this.renderHistory();
        this.layout();
    }

    progress() {
        const state = this.music?.state;
        if (!state)
            return;
        const position = this.music.position();
        this.elapsed.text = time(position);
        this.duration.text = time(state.length);
        if (!this.dragging) {
            this.updating = true;
            this.slider.value = state.length ? position / state.length : 0;
            this.updating = false;
        }
    }

    refreshTicker() {
        const shouldTick = this.life.alive && this.compact.mapped && !this.hidden() && this.music?.state.playing;
        if (!shouldTick) {
            this.life.cancel(this.tickId);
            this.tickId = 0;
            return;
        }
        if (this.tickId)
            return;
        this.tickId = this.life.after(1000, () => {
            this.tickId = 0;
            if (this.expanded)
                this.progress();
            if (!this.current && !this.event && this.interface.get_boolean('enable-animations'))
                this.wave.text = ['▂▅▃', '▅▂▆', '▃▆▂'][this.waveStep++ % 3];
            this.refreshTicker();
        });
    }

    notification(notification, present) {
        if (this.current?.notification === notification) {
            this.renderPreview();
            this.armPreview();
            return;
        }
        this.queue = this.queue.filter(item => item.notification !== notification && !item.notification._destroyed);
        this.queue.push({notification, present});
        this.queue.sort((a, b) => b.notification.urgency - a.notification.urgency);
        this.queue = this.queue.slice(0, 16);
        this.nextPreview();
    }

    suppressAlerts(source = null) {
        const suppress = n => source ? n.source === source &&
            (!source.policy.enable || n.urgency !== 3) : n.urgency !== 3;
        this.queue = this.queue.filter(item => !suppress(item.notification));
        if (this.current && suppress(this.current.notification))
            this.clearPreview(false);
        this.nextPreview();
    }

    nextPreview() {
        if (this.expanded || this.current || this.hidden())
            return;
        while (this.queue.length) {
            const item = this.queue.shift();
            if (item.notification._destroyed || !item.present())
                continue;
            this.event = null;
            this.life.cancel(this.eventId);
            this.current = item;
            this.renderPreview();
            this.armPreview();
            return;
        }
        this.updateMusic();
    }

    renderPreview() {
        this.preview.destroy_all_children();
        if (!this.current)
            return;
        const n = this.current.notification;
        this.compactTitle.text = plainText(n.source.title || 'Notificación');
        this.compactTitle.show();
        this.wave.text = '•';
        this.preview.add_child(this.notificationCard(n, true));
        this.preview.visible = !this.expanded;

        const wasVisible = this.root.visible;
        this.syncPopup();

        // iOS Dynamic Island Notification Arrival Animation
        if (!wasVisible && this.interface.get_boolean('enable-animations')) {
            this.root.translation_y = -10;
            this.root.opacity = 0;
            this.layout(false);
            this.root.add_style_class_name('liquid-preview-glow');
            this.root.ease({
                translation_y: 0, opacity: 255,
                duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            this.layout(true);
        }
    }

    armPreview() {
        this.life.cancel(this.previewId);
        if (!this.current || this.current.notification.urgency === 3 || this.expanded)
            return;
        this.previewId = this.life.after(5500, () => {
            if (this.root.hover) {
                this.armPreview();
                return;
            }
            this.clearPreview(true);
        });
    }

    clearPreview(animate = true) {
        this.life.cancel(this.previewId);
        if (animate && this.root.visible && !this.expanded && this.interface.get_boolean('enable-animations')) {
            this.root.remove_all_transitions();
            this.root.ease({
                translation_y: -8, opacity: 0,
                duration: 180, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onStopped: () => this.finalizeClearPreview(),
            });
        } else {
            this.finalizeClearPreview();
        }
    }

    finalizeClearPreview() {
        this.current = null;
        this.preview.destroy_all_children();
        this.preview.hide();
        this.root.remove_style_class_name('liquid-preview-glow');
        this.root.translation_y = 0;
        this.root.opacity = 255;
        this.syncPopup();
        this.nextPreview();
    }

    openNotification(n) {
        if (!n || n._destroyed)
            return;
        n.acknowledged = true;
        try { n.activate(); } catch (_) {}
        try {
            if (typeof n.source?.open === 'function')
                n.source.open();
            else if (typeof n.source?.openApp === 'function')
                n.source.openApp();
            else if (n.source?.app)
                n.source.app.activate();
        } catch (_) {}
        this.close(false);
        if (this.current?.notification === n)
            this.clearPreview(false);
    }

    notificationCard(n, preview = false) {
        const card = new St.Button({
            can_focus: true,
            x_expand: true,
            style_class: 'liquid-notification-card',
            accessible_name: `Abrir notificación de ${plainText(n.source.title)}`,
        });
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-notification', x_expand: true});
        card.set_child(box);

        const heading = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
        const sourceIcon = n.source.icon ?
            new St.Icon({gicon: n.source.icon, icon_size: 16, style_class: 'liquid-notif-icon'}) :
            new St.Icon({icon_name: 'dialog-information-symbolic', icon_size: 16, style_class: 'liquid-notif-icon'});
        heading.add_child(sourceIcon);

        const titleLabel = label(plainText(n.title || n.source.title), 'liquid-title');
        titleLabel.x_expand = true;
        heading.add_child(titleLabel);

        const closeBtn = button('window-close-symbolic', 'Descartar notificación', () => {
            if (!n._destroyed)
                n.destroy();
            if (preview)
                this.clearPreview(true);
        }, 'liquid-aio-action-btn');
        closeBtn.connect('button-press-event', () => Clutter.EVENT_STOP);
        heading.add_child(closeBtn);
        box.add_child(heading);

        if (n.body) {
            const body = label(plainText(n.body));
            body.clutter_text.line_wrap = true;
            body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            body.clutter_text.set_single_line_mode(false);
            body.set_style('max-height: 60px;');
            box.add_child(body);
        }

        card.connect('clicked', () => this.openNotification(n));

        if (n.actions.length) {
            const actions = new St.BoxLayout({style: 'spacing: 6px; padding-top: 4px;'});
            for (const action of n.actions.slice(0, 3)) {
                const actor = new St.Button({label: plainText(action.label), can_focus: true,
                    style_class: 'liquid-aio-action-btn', x_expand: true});
                actor.connect('clicked', () => {
                    if (!n._destroyed) {
                        n.acknowledged = true;
                        action.activate();
                    }
                    this.close(false);
                    if (preview)
                        this.clearPreview(false);
                });
                actor.connect('button-press-event', () => Clutter.EVENT_STOP);
                actions.add_child(actor);
            }
            box.add_child(actions);
        }
        return card;
    }

    historyChanged() {
        if (this.current && !this.current.notification.source.notifications.includes(this.current.notification))
            this.clearPreview(true);
        this.queue = this.queue.filter(item => !item.notification._destroyed);
        if (this.expanded) {
            this.life.cancel(this.historyId);
            this.historyId = this.life.after(80, () => this.renderHistory());
        }
        if (!this.current && !this.event)
            this.updateMusic();
    }

    renderHistory() {
        this.historyBox.destroy_all_children();
        const notifications = this.notifications?.list() ?? [];
        if (this.notifBadge)
            this.notifBadge.text = String(notifications.length);
        if (this.clearAllBtn)
            this.clearAllBtn.visible = notifications.length > 0;
        if (!notifications.length) {
            const emptyBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 4px; padding: 14px 8px;'});
            emptyBox.add_child(new St.Icon({icon_name: 'emblem-ok-symbolic', icon_size: 20, style_class: 'liquid-empty-icon'}));
            emptyBox.add_child(label('Todo al día · No hay notificaciones', 'liquid-empty'));
            this.historyBox.add_child(emptyBox);
        } else {
            for (const notification of notifications.slice(0, 20))
                this.historyBox.add_child(this.notificationCard(notification));
        }
    }

    systemEvent(event) {
        if (this.hidden() || this.current)
            return false;
        this.life.cancel(this.eventId);
        this.event = event;
        this.compactTitle.text = `${event.title}${event.level != null ? `  ${Math.round(event.level * 100)} %` : event.detail ? ` · ${event.detail}` : ''}`;
        this.compactTitle.show();
        this.smallCover.gicon = event.gicon ?? null;
        if (!event.gicon)
            this.smallCover.icon_name = event.icon || 'dialog-information-symbolic';
        this.wave.text = event.level == null ? '·' : '━';
        this.layout(true);
        this.eventId = this.life.after(event.key === 'battery' ? 4000 : 1600, () => {
            this.event = null;
            this.updateMusic();
            this.nextPreview();
        });
        return true;
    }

    destroy() {
        this.destroying = true;
        this.close(false);
        this.life.destroy();
        this.queue = [];
        this.current = null;
        this.music = null;
        this.notifications = null;
        for (const cls of ['liquid-desktop', 'liquid-light', 'liquid-dark'])
            Main.uiGroup.remove_style_class_name(cls);
        this.root.remove_all_transitions();
        this.root.hide();
        this.panelButton.destroy();
        this.backdrop.destroy();
        Main.layoutManager.removeChrome(this.root);
        this.root.destroy();
    }
}
