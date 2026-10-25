import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Lifetime} from './lifecycle.js';
import {plainText} from './policy.js';
import {Backdrop} from './backdrop.js';

function label(text = '', style = 'liquid-subtitle') {
    const actor = new St.Label({
        text,
        style_class: style,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function button(icon, name, action, style = 'liquid-control') {
    const actor = new St.Button({
        style_class: style,
        can_focus: true,
        accessible_name: name,
        child: new St.Icon({icon_name: icon, icon_size: 18}),
    });
    actor.connect('clicked', action);
    return actor;
}

function time(us) {
    const seconds = Math.max(0, Math.floor(us / 1000000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function hexToRgba(hex, alpha = 1.0) {
    const clean = String(hex || '#5ac8fa').replace('#', '');
    if (clean.length !== 6)
        return `rgba(90, 200, 250, ${alpha})`;
    const r = parseInt(clean.slice(0, 2), 16) || 90;
    const g = parseInt(clean.slice(2, 4), 16) || 200;
    const b = parseInt(clean.slice(4, 6), 16) || 250;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class Island {
    constructor(settings, openPreferences) {
        this.life = new Lifetime();
        this.settings = settings;
        this.interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.openPreferences = openPreferences;
        this.expanded = false;
        this.closing = false;
        this.animationGeneration = 0;
        this.overviewActive = Boolean(Main.overview.visible);
        this.activeTab = 'notifications';
        this.queue = [];
        this.current = null;
        this.event = null;
        this.music = null;
        this.notifications = null;
        this.telemetry = null;
        this.telemetryState = {cpu: 0, ram: 0, temp: null};
        this.tickId = 0;
        this.waveStep = 0;
        this.wallClock = new GnomeDesktop.WallClock();
        this.wallClock.force_seconds = this.getSettingBool('clock-show-seconds', false);

        const now = GLib.DateTime.new_now_local();
        this.calYear = now.get_year();
        this.calMonth = now.get_month();
        this.selectedDay = now.get_day_of_month();

        this.root = new St.Widget({
            style_class: 'liquid-island',
            visible: false,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            clip_to_allocation: false,
        });
        this.surface = new St.BoxLayout({
            style_class: 'liquid-surface liquid-compact',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.root.add_child(this.surface);
        this.backdrop = new Backdrop(this.root, settings);
        this.build();

        // Single unified panel button
        this.panelButton = new PanelMenu.Button(0.5, 'Liquid Island', true);
        this.panelButton.can_focus = false;
        this.panelButton.add_style_class_name('liquid-panel-media');
        this.panelButton.add_child(this.compact);
        this.currentPanelBox = null;
        this.syncPanelPosition();

        // Unify: hide separate GNOME dateMenu so there are not two clock buttons
        if (Main.panel.statusArea.dateMenu?.container)
            Main.panel.statusArea.dateMenu.container.hide();

        Main.layoutManager.addTopChrome(this.root, {affectsStruts: false, trackFullscreen: true});

        this.life.connect(this.wallClock, 'notify::clock', () => this.updateClock());
        this.life.connect(Main.panel._centerBox, 'notify::allocation', () => this.layout());
        for (const role of ['dateMenu', 'quickSettings']) {
            const menu = Main.panel.statusArea[role]?.menu;
            if (menu)
                this.life.connect(menu, 'open-state-changed', (_menu, open) => { if (open) this.close(false); });
        }
        this.life.connect(Main.layoutManager, 'monitors-changed', () => this.visibility());
        this.life.connect(global.display, 'in-fullscreen-changed', () => this.visibility());
        for (const sig of ['showing', 'shown', 'hiding', 'hidden']) {
            this.life.connect(Main.overview, sig, () => {
                // The showing signal can precede overview.visible changing.
                this.overviewActive = sig !== 'hidden';
                this.visibility();
            });
        }
        this.life.connect(Main.sessionMode, 'updated', () => this.visibility());
        this.life.connect(Main.panel, 'notify::height', () => this.layout());
        this.life.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => {
            this.appearance();
            this.layout();
        });
        this.life.connect(settings, 'changed', (_s, key) => {
            if (key === 'island-position')
                this.syncPanelPosition();
            if (key === 'island-module-order')
                this.syncModuleOrder();
            if (key === 'clock-show-seconds')
                this.wallClock.force_seconds = this.getSettingBool('clock-show-seconds', false);
            if (key === 'calendar-week-start')
                this.renderCalendarGrid();
            if (key === 'pinned-island-apps' || key === 'show-quick-controls')
                this.renderQuickApps();
            if (key.startsWith('clock-'))
                this.updateClock();
            this.appearance();
            this.updateTelemetry(this.telemetryState);
            this.updateMusic();
            this.layout(false);
        });
        this.life.connect(this.interface, 'changed::color-scheme', () => {
            this.appearance();
            this.syncQuickToggles();
        });
        this.life.connect(this.notifSettings, 'changed::show-banners', () => this.syncQuickToggles());
        this.life.connect(this.interface, 'changed::enable-animations', () => this.refreshTicker());
        this.life.connect(global.stage, 'captured-event', (_stage, event) => this.capture(event));
        this.life.connect(this.root, 'notify::hover', () => {
            if (!this.root.hover && this.current && this.current.notification.urgency !== 3)
                this.armPreview();
        });
        this.root.track_hover = true;
        this.appearance();
        this.updateClock();
        this.renderCalendarGrid();
        this.renderQuickApps();
        this.syncQuickToggles();
        this.visibility();
    }

    getSettingBool(key, fallback) {
        try {
            return this.settings.get_boolean(key);
        } catch (_) {
            return fallback;
        }
    }

    getSettingInt(key, fallback) {
        try {
            return this.settings.get_int(key);
        } catch (_) {
            return fallback;
        }
    }

    getSettingDouble(key, fallback) {
        try {
            return this.settings.get_double(key);
        } catch (_) {
            return fallback;
        }
    }

    getSettingString(key, fallback) {
        try {
            return this.settings.get_string(key);
        } catch (_) {
            return fallback;
        }
    }

    getSettingStrv(key, fallback) {
        try {
            return this.settings.get_strv(key);
        } catch (_) {
            return fallback;
        }
    }

    animationsEnabled() {
        return this.getSettingBool('enable-animations', true) &&
            this.interface.get_boolean('enable-animations');
    }

    animDuration(baseMs) {
        if (!this.animationsEnabled())
            return 0;
        const speed = Math.max(0.5, Math.min(2.0, this.getSettingDouble('animation-speed', 1.0)));
        return Math.round(baseMs / speed);
    }

    syncPanelPosition() {
        const pos = this.getSettingString('island-position', 'center');
        const boxMap = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
        const targetBox = boxMap[pos] || Main.panel._centerBox;
        if (!Main.panel.statusArea.liquidIsland) {
            Main.panel.addToStatusArea('liquidIsland', this.panelButton, 1, pos);
            this.currentPanelBox = targetBox;
            return;
        }
        const container = this.panelButton.container;
        const parent = container.get_parent();
        if (parent && parent !== targetBox) {
            parent.remove_child(container);
            if (pos === 'left')
                targetBox.insert_child_at_index(container, targetBox.get_n_children());
            else if (pos === 'right')
                targetBox.insert_child_at_index(container, 0);
            else
                targetBox.add_child(container);
            this.currentPanelBox = targetBox;
        }
    }

    build() {
        this.compact = new St.Button({
            can_focus: true,
            accessible_name: 'Dynamic Island',
            x_expand: true,
            style_class: 'liquid-compact-button',
        });
        const row = new St.BoxLayout({
            style_class: 'liquid-pill-row',
            style: 'spacing: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // 1. Clock & Date Display
        this.clockBox = new St.BoxLayout({
            style_class: 'liquid-clock-box',
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.clockIcon = new St.Icon({
            icon_name: 'preferences-system-time-symbolic',
            icon_size: 14,
            style_class: 'liquid-clock-icon',
        });
        this.clockLabel = label('', 'liquid-title liquid-clock-text');
        this.clockBox.add_child(this.clockIcon);
        this.clockBox.add_child(this.clockLabel);
        row.add_child(this.clockBox);

        // 2. Telemetry Pill Chip (Optional live CPU/RAM in top bar)
        this.telemetryPillSep = label('│', 'liquid-pill-separator');
        this.telemetryPillSep.visible = false;
        row.add_child(this.telemetryPillSep);

        this.telemetryPillLabel = label('CPU 0%', 'liquid-telemetry-pill');
        this.telemetryPillLabel.visible = false;
        this.telemetryPillLabel.x_expand = false;
        row.add_child(this.telemetryPillLabel);

        // 3. Subtle Pill Separator (Visible when music, OSD, or badge is active)
        this.pillSeparator = label('│', 'liquid-pill-separator');
        this.pillSeparator.visible = false;
        row.add_child(this.pillSeparator);

        // 4. Music Chip
        this.musicChip = new St.BoxLayout({
            style_class: 'liquid-music-chip',
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.smallCover = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 15,
            style_class: 'liquid-cover',
        });
        this.compactTitle = label('', 'liquid-title liquid-track-title');
        this.compactTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.wave = label('▂▅▃', 'liquid-wave');
        this.wave.x_expand = false;
        this.musicChip.add_child(this.smallCover);
        this.musicChip.add_child(this.compactTitle);
        this.musicChip.add_child(this.wave);
        row.add_child(this.musicChip);

        // 5. Dedicated Animated OSD Chip (Volume / Brightness / Battery with real progress bar)
        this.osdChip = new St.BoxLayout({
            style_class: 'liquid-osd-chip',
            style: 'spacing: 7px;',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.osdIcon = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            icon_size: 15,
            style_class: 'liquid-osd-icon',
        });
        this.osdTitle = label('', 'liquid-title liquid-osd-title');
        this.osdTitle.x_expand = false;
        this.osdBarTrack = new St.Widget({
            style_class: 'liquid-osd-bar-track',
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this.osdBarFill = new St.Widget({
            style_class: 'liquid-osd-bar-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.osdBarTrack.add_child(this.osdBarFill);
        this.osdPercent = label('', 'liquid-osd-percent');
        this.osdPercent.x_expand = false;
        this.osdChip.add_child(this.osdIcon);
        this.osdChip.add_child(this.osdTitle);
        this.osdChip.add_child(this.osdBarTrack);
        this.osdChip.add_child(this.osdPercent);
        row.add_child(this.osdChip);

        // 6. Notification Pill Badge
        this.pillBadge = new St.Label({
            text: '',
            style_class: 'liquid-pill-badge',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this.pillBadge);

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

        // Banner preview container
        this.preview = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            visible: false,
        });
        this.surface.add_child(this.preview);

        // Unified All-in-One container (Dropdown)
        this.content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 12px; padding: 4px 2px;',
            visible: false,
        });
        this.surface.add_child(this.content);

        // Top Header Bar + Quick Control Toggles
        const header = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const headerIcon = new St.Icon({
            icon_name: 'preferences-system-time-symbolic',
            icon_size: 15,
            style_class: 'liquid-wave',
        });
        this.headerTitle = label('LIQUID ISLAND', 'liquid-section');
        header.add_child(headerIcon);
        header.add_child(this.headerTitle);

        this.dndBtn = button('notifications-disabled-symbolic', 'No Molestar', () => {
            const curr = this.notifSettings.get_boolean('show-banners');
            this.notifSettings.set_boolean('show-banners', !curr);
            this.syncQuickToggles();
        }, 'liquid-aio-action-btn');
        header.add_child(this.dndBtn);

        this.themeBtn = button('weather-clear-night-symbolic', 'Alternar Tema Oscuro/Claro', () => {
            const scheme = this.interface.get_string('color-scheme');
            const nextScheme = scheme === 'prefer-dark' ? 'default' : 'prefer-dark';
            this.interface.set_string('color-scheme', nextScheme);
            this.settings.set_string('appearance', 'auto');
            this.syncQuickToggles();
        }, 'liquid-aio-action-btn');
        header.add_child(this.themeBtn);

        this.shotBtn = button('camera-photo-symbolic', 'Captura de Pantalla', () => {
            this.close(false);
            if (Main.screenshotUI?.open)
                Main.screenshotUI.open();
        }, 'liquid-aio-action-btn');
        header.add_child(this.shotBtn);

        this.clearAllBtn = button('user-trash-symbolic', 'Limpiar todas las notificaciones', () => {
            this.notifications?.clearAll();
        }, 'liquid-aio-action-btn');
        this.clearAllBtn.visible = false;
        header.add_child(this.clearAllBtn);

        const prefsBtn = button('emblem-system-symbolic', 'Centro de Control Liquid Glass', () => {
            this.close(false);
            this.openPreferences?.();
        }, 'liquid-aio-action-btn');
        header.add_child(prefsBtn);
        this.content.add_child(header);

        // Quick App Launcher Row (Pinned Island Apps)
        this.quickAppsRow = new St.BoxLayout({
            style_class: 'liquid-quick-apps-row',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this.content.add_child(this.quickAppsRow);

        // Live Hardware Telemetry Card (CPU / RAM / Temp)
        this.telemetryCard = new St.BoxLayout({
            style_class: 'liquid-telemetry-card',
            x_expand: true,
            style: 'spacing: 10px;',
        });
        this.cpuMetric = this.buildMetricWidget('CPU', '0%');
        this.ramMetric = this.buildMetricWidget('RAM', '0%');
        this.tempMetric = this.buildMetricWidget('TEMP', '--°C');
        this.telemetryCard.add_child(this.cpuMetric.box);
        this.telemetryCard.add_child(this.ramMetric.box);
        this.telemetryCard.add_child(this.tempMetric.box);
        this.content.add_child(this.telemetryCard);

        // Media Player Section
        this.player = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 10px;',
            visible: false,
        });
        this.playerSelector = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 4px;',
            visible: false,
        });
        this.player.add_child(this.playerSelector);
        const song = new St.BoxLayout({style: 'spacing: 14px;'});
        this.cover = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 64,
            style_class: 'liquid-cover',
        });
        this.coverButton = new St.Button({
            can_focus: true,
            accessible_name: 'Abrir reproductor',
            style_class: 'liquid-cover-button',
            child: this.cover,
        });
        this.coverButton.connect('clicked', () => this.music?.raise());

        const description = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'spacing: 3px;',
        });
        const tagRow = new St.BoxLayout({style: 'spacing: 6px;'});
        this.nowPlayingTag = label('NOW PLAYING', 'liquid-section liquid-spotify-tag');
        tagRow.add_child(this.nowPlayingTag);
        description.add_child(tagRow);

        this.title = label('Reproductor', 'liquid-title liquid-song-title');
        this.titleButton = new St.Button({
            can_focus: true,
            accessible_name: 'Abrir reproductor',
            style_class: 'liquid-title-button',
            child: this.title,
        });
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
        this.raiseBtn = button('audio-x-generic-symbolic', 'Abrir reproductor', () => this.music?.raise(),
            'liquid-control liquid-spotify-btn');
        controls.add_child(this.previous);
        controls.add_child(this.play);
        controls.add_child(this.next);
        controls.add_child(this.raiseBtn);
        this.player.add_child(controls);
        this.content.add_child(this.player);

        // Divider (visible only when player is visible)
        this.playerDivider = new St.Widget({style_class: 'liquid-divider', x_expand: true, visible: false});
        this.content.add_child(this.playerDivider);

        // Segmented Tabs Header: [ 🔔 Notificaciones ] | [ 📅 Calendario ]
        const tabsRow = new St.BoxLayout({style_class: 'liquid-segmented-pill', x_align: Clutter.ActorAlign.CENTER});
        this.notifTabBtn = new St.Button({
            can_focus: true,
            style_class: 'liquid-tab liquid-tab-active',
            label: '🔔 Notificaciones',
        });
        this.calTabBtn = new St.Button({
            can_focus: true,
            style_class: 'liquid-tab',
            label: '📅 Calendario',
        });
        tabsRow.add_child(this.notifTabBtn);
        tabsRow.add_child(this.calTabBtn);
        this.notifTabBtn.connect('clicked', () => this.switchTab('notifications'));
        this.calTabBtn.connect('clicked', () => this.switchTab('calendar'));
        this.tabsRow = tabsRow;
        this.content.add_child(tabsRow);

        // Tab View 1: Notifications
        this.history = new St.ScrollView({
            visible: true,
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this.historyBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            x_expand: true,
        });
        this.history.set_child(this.historyBox);
        this.content.add_child(this.history);

        // Tab View 2: Native 7-Column Liquid Glass Calendar
        this.calendarContainer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-cal-card',
            x_expand: true,
            visible: false,
        });
        this.buildCustomCalendar();
        this.content.add_child(this.calendarContainer);
        this.moduleActors = {
            music: [this.player, this.playerDivider],
            quick: [this.quickAppsRow],
            telemetry: [this.telemetryCard],
            notifications: [this.history],
            calendar: [this.calendarContainer],
        };
        // Header and tab navigation stay reachable above the ordered sections.
        this.content.set_child_at_index(this.tabsRow, 1);
        this.syncModuleOrder();
    }

    syncModuleOrder() {
        if (!this.moduleActors)
            return;
        const defaults = ['music', 'quick', 'telemetry', 'notifications', 'calendar'];
        const requested = this.getSettingStrv('island-module-order', defaults);
        const order = [...new Set([...requested, ...defaults])].filter(name => defaults.includes(name));
        let index = 2;
        for (const name of order) {
            for (const actor of this.moduleActors[name])
                this.content.set_child_at_index(actor, index++);
        }
    }

    buildMetricWidget(titleText, initialValue) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-metric-item',
            x_expand: true,
        });
        const top = new St.BoxLayout({x_expand: true});
        const nameLabel = label(titleText, 'liquid-metric-label');
        const valLabel = label(initialValue, 'liquid-metric-value');
        valLabel.x_expand = false;
        top.add_child(nameLabel);
        top.add_child(valLabel);

        const track = new St.Widget({
            style_class: 'liquid-metric-bar-track',
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        const fill = new St.Widget({
            style_class: 'liquid-metric-bar-fill',
            x_align: Clutter.ActorAlign.START,
        });
        track.add_child(fill);

        box.add_child(top);
        box.add_child(track);
        return {box, valLabel, fill};
    }

    updateTelemetry(state) {
        if (!this.life.alive || !state)
            return;
        this.telemetryState = state;
        const cpu = Math.max(0, Math.min(100, Math.round(state.cpu || 0)));
        const ram = Math.max(0, Math.min(100, Math.round(state.ram || 0)));
        const temp = state.temp != null ? Math.round(state.temp) : null;

        const showPill = this.getSettingBool('show-telemetry-pill', false);
        this.telemetryPillSep.visible = showPill;
        this.telemetryPillLabel.visible = showPill;
        if (showPill)
            this.telemetryPillLabel.text = `CPU ${cpu}% · RAM ${ram}%`;

        const showPanel = this.getSettingBool('show-telemetry-panel', true);
        if (this.telemetryCard) {
            this.telemetryCard.visible = showPanel;
            this.cpuMetric.valLabel.text = `${cpu}%`;
            this.cpuMetric.fill.set_style(`width: ${Math.max(4, Math.round(cpu * 0.95))}px;`);
            this.ramMetric.valLabel.text = `${ram}%`;
            this.ramMetric.fill.set_style(`width: ${Math.max(4, Math.round(ram * 0.95))}px;`);
            if (temp != null && temp > 0) {
                this.tempMetric.valLabel.text = `${temp}°C`;
                const pct = Math.max(0, Math.min(100, Math.round(((temp - 25) / 70) * 100)));
                this.tempMetric.fill.set_style(`width: ${Math.max(4, Math.round(pct * 0.95))}px;`);
            } else {
                this.tempMetric.valLabel.text = 'N/A';
                this.tempMetric.fill.set_style('width: 12px;');
            }
        }
    }

    syncQuickToggles() {
        if (!this.life.alive)
            return;
        const dndActive = !this.notifSettings.get_boolean('show-banners');
        if (this.dndBtn) {
            if (dndActive)
                this.dndBtn.add_style_class_name('liquid-quick-toggle-active');
            else
                this.dndBtn.remove_style_class_name('liquid-quick-toggle-active');
        }
        if (this.themeBtn) {
            const isDark = this.interface.get_string('color-scheme') === 'prefer-dark';
            this.themeBtn.child.icon_name = isDark ? 'weather-clear-night-symbolic' : 'weather-clear-symbolic';
            if (isDark)
                this.themeBtn.add_style_class_name('liquid-quick-toggle-active');
            else
                this.themeBtn.remove_style_class_name('liquid-quick-toggle-active');
        }
    }

    renderQuickApps() {
        if (!this.quickAppsRow)
            return;
        this.quickAppsRow.destroy_all_children();
        const showQuick = this.getSettingBool('show-quick-controls', true);
        if (this.dndBtn)
            this.dndBtn.visible = showQuick;
        if (this.themeBtn)
            this.themeBtn.visible = showQuick;
        if (this.shotBtn)
            this.shotBtn.visible = showQuick;

        if (!showQuick) {
            this.quickAppsRow.visible = false;
            return;
        }

        const appIds = this.getSettingStrv('pinned-island-apps', [
            'org.gnome.Nautilus.desktop',
            'org.gnome.Ptyxis.desktop',
            'org.gnome.Settings.desktop',
            'com.spotify.Client.desktop',
        ]);
        const appSystem = Shell.AppSystem.get_default();
        let added = 0;

        for (const id of appIds.slice(0, 8)) {
            const app = appSystem.lookup_app(id);
            if (!app)
                continue;
            const icon = app.create_icon_texture(22);
            const btn = new St.Button({
                style_class: 'liquid-quick-app-btn',
                can_focus: true,
                accessible_name: app.get_name(),
                child: icon,
            });
            btn.connect('clicked', () => {
                this.close(false);
                app.activate();
            });
            this.quickAppsRow.add_child(btn);
            added++;
        }
        this.quickAppsRow.visible = added > 0;
    }

    buildCustomCalendar() {
        this.calendarDateLabel = label('', 'liquid-calendar-date-header');
        this.calendarContainer.add_child(this.calendarDateLabel);

        const navRow = new St.BoxLayout({
            style_class: 'liquid-cal-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const prevBtn = button('go-previous-symbolic', 'Mes anterior', () => this.changeMonth(-1), 'liquid-cal-nav-btn');
        const nextBtn = button('go-next-symbolic', 'Mes siguiente', () => this.changeMonth(1), 'liquid-cal-nav-btn');
        this.calMonthTitle = label('', 'liquid-cal-month-title');
        this.calMonthTitle.clutter_text.x_align = Clutter.ActorAlign.CENTER;

        this.calTodayBtn = new St.Button({
            label: 'Hoy',
            can_focus: true,
            style_class: 'liquid-cal-today-btn',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.calTodayBtn.connect('clicked', () => {
            const now = GLib.DateTime.new_now_local();
            this.calYear = now.get_year();
            this.calMonth = now.get_month();
            this.selectedDay = now.get_day_of_month();
            this.renderCalendarGrid();
            this.layout(false);
        });

        navRow.add_child(prevBtn);
        navRow.add_child(this.calMonthTitle);
        navRow.add_child(this.calTodayBtn);
        navRow.add_child(nextBtn);
        this.calendarContainer.add_child(navRow);

        this.calGridLayout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: false,
            column_spacing: 6,
            row_spacing: 6,
        });
        this.calGrid = new St.Widget({
            style_class: 'liquid-cal-grid',
            layout_manager: this.calGridLayout,
            x_expand: true,
        });
        this.calendarContainer.add_child(this.calGrid);
    }

    changeMonth(delta) {
        let m = this.calMonth + delta;
        let y = this.calYear;
        if (m < 1) {
            m = 12;
            y--;
        } else if (m > 12) {
            m = 1;
            y++;
        }
        this.calMonth = m;
        this.calYear = y;
        this.renderCalendarGrid();
        this.layout(false);
    }

    renderCalendarGrid() {
        if (!this.calGrid || !this.calGridLayout)
            return;
        this.calGrid.destroy_all_children();

        const now = GLib.DateTime.new_now_local();
        const todayY = now.get_year();
        const todayM = now.get_month();
        const todayD = now.get_day_of_month();

        const firstOfMonth = GLib.DateTime.new_local(this.calYear, this.calMonth, 1, 12, 0, 0);
        const rawTitle = firstOfMonth.format('%B %Y') || `${this.calMonth}/${this.calYear}`;
        this.calMonthTitle.text = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
        this.calTodayBtn.visible = this.calYear !== todayY || this.calMonth !== todayM;

        const weekStart = this.getSettingInt('calendar-week-start', 1); // 1 = Monday, 0 = Sunday
        const weekdaysMon = ['LU', 'MA', 'MI', 'JU', 'VI', 'SÁ', 'DO'];
        const weekdaysSun = ['DO', 'LU', 'MA', 'MI', 'JU', 'VI', 'SÁ'];
        const headers = weekStart === 0 ? weekdaysSun : weekdaysMon;

        for (let col = 0; col < 7; col++) {
            const isWeekendCol = weekStart === 1 ? col >= 5 : (col === 0 || col === 6);
            const wdLabel = new St.Label({
                text: headers[col],
                style_class: isWeekendCol ? 'liquid-cal-weekday liquid-cal-weekday-weekend' : 'liquid-cal-weekday',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this.calGridLayout.attach(wdLabel, col, 0, 1, 1);
        }

        // GLib day_of_week: 1 = Monday .. 7 = Sunday
        const firstDow = firstOfMonth.get_day_of_week();
        const leadingDays = weekStart === 1 ? (firstDow - 1) : (firstDow % 7);

        const daysInMonth = GLib.Date.get_days_in_month(this.calMonth, this.calYear);
        const prevMonth = this.calMonth === 1 ? 12 : this.calMonth - 1;
        const prevYear = this.calMonth === 1 ? this.calYear - 1 : this.calYear;
        const daysInPrevMonth = GLib.Date.get_days_in_month(prevMonth, prevYear);

        for (let idx = 0; idx < 42; idx++) {
            const col = idx % 7;
            const row = Math.floor(idx / 7) + 1;
            const isWeekend = weekStart === 1 ? col >= 5 : (col === 0 || col === 6);

            let dayNum;
            let monthOffset = 0;
            if (idx < leadingDays) {
                dayNum = daysInPrevMonth - leadingDays + idx + 1;
                monthOffset = -1;
            } else if (idx >= leadingDays + daysInMonth) {
                dayNum = idx - (leadingDays + daysInMonth) + 1;
                monthOffset = 1;
            } else {
                dayNum = idx - leadingDays + 1;
                monthOffset = 0;
            }

            const isToday = monthOffset === 0 &&
                this.calYear === todayY &&
                this.calMonth === todayM &&
                dayNum === todayD;

            const isSelected = monthOffset === 0 &&
                this.selectedDay === dayNum &&
                !isToday;

            let cls = 'liquid-cal-day';
            if (monthOffset !== 0)
                cls += ' liquid-cal-day-other';
            else if (isToday)
                cls += ' liquid-cal-day-today';
            else if (isSelected)
                cls += ' liquid-cal-day-selected';
            else if (isWeekend)
                cls += ' liquid-cal-day-weekend';

            const cellBtn = new St.Button({
                label: String(dayNum),
                can_focus: true,
                style_class: cls,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });

            if (isToday && this.activeAccentColor) {
                cellBtn.set_style(
                    `background-color: ${this.activeAccentColor} !important; color: #081018 !important; ` +
                    `box-shadow: 0 3px 12px ${hexToRgba(this.activeAccentColor, 0.55)};`
                );
            }

            cellBtn.connect('clicked', () => {
                if (monthOffset !== 0) {
                    this.selectedDay = dayNum;
                    this.changeMonth(monthOffset);
                } else {
                    this.selectedDay = dayNum;
                    const clickedDate = GLib.DateTime.new_local(this.calYear, this.calMonth, dayNum, 12, 0, 0);
                    const formatted = clickedDate.format('%A, %d de %B de %Y');
                    if (formatted)
                        this.calendarDateLabel.text = formatted.charAt(0).toUpperCase() + formatted.slice(1);
                    this.renderCalendarGrid();
                }
            });

            this.calGridLayout.attach(cellBtn, col, row, 1, 1);
        }
    }

    switchTab(tab) {
        this.activeTab = tab;
        if (tab === 'notifications') {
            this.notifTabBtn.add_style_class_name('liquid-tab-active');
            this.calTabBtn.remove_style_class_name('liquid-tab-active');
            this.calendarContainer.hide();
            this.history.show();
            this.renderHistory();
        } else {
            this.calTabBtn.add_style_class_name('liquid-tab-active');
            this.notifTabBtn.remove_style_class_name('liquid-tab-active');
            this.history.hide();
            this.renderCalendarGrid();
            this.calendarContainer.show();
        }
        this.layout(false);
    }

    updateClock() {
        if (!this.life.alive)
            return;
        const dt = GLib.DateTime.new_now_local();
        const use24h = this.getSettingBool('clock-use-24h', true);
        const showSec = this.getSettingBool('clock-show-seconds', false);
        const showDate = this.getSettingBool('clock-show-date', true);

        const timeFmt = use24h ? (showSec ? '%H:%M:%S' : '%H:%M') : (showSec ? '%I:%M:%S %p' : '%I:%M %p');
        const datePrefix = showDate ? `${dt.format('%a %d %b') ?? ''}  ` : '';
        this.clockLabel.text = `${datePrefix}${dt.format(timeFmt) ?? (this.wallClock?.clock ?? '')}`.trim();

        if (this.calendarDateLabel) {
            const fullDate = dt.format('%A, %d de %B de %Y') ?? '';
            this.calendarDateLabel.text = fullDate ? fullDate.charAt(0).toUpperCase() + fullDate.slice(1) : '';
        }
        this.layout(false);
    }

    hidden() {
        const monitor = Main.layoutManager.primaryMonitor;
        const inOverview = Boolean(this.overviewActive || Main.overview.visible ||
            Main.overview._shown ||
            Main.overview._visibleTarget ||
            Main.overview.animationInProgress);
        return !monitor || inOverview || Main.sessionMode.isLocked ||
            Main.sessionMode.isGreeter || global.display.get_monitor_in_fullscreen(monitor.index);
    }

    cancelPopupAnimation() {
        // Invalidate callbacks before stopping transitions: Clutter may invoke
        // onStopped synchronously when a transition is removed.
        const generation = ++this.animationGeneration;
        this.root.remove_all_transitions();
        this.root.translation_y = 0;
        this.root.scale_y = 1;
        this.root.scale_x = 1;
        this.root.opacity = 255;
        this.layoutTarget = null;
        return generation;
    }

    visibility() {
        const hidden = this.hidden();
        if (hidden) {
            this.cancelPopupAnimation();
            this.expanded = false;
            this.closing = false;
            this.savedFocus = null;
            this.queue = [];
            this.current = null;
            this.event = null;
            this.life.cancel(this.previewId);
            this.life.cancel(this.eventId);
            this.preview.destroy_all_children();
            this.preview.hide();
            this.content.hide();
            this.osdChip.hide();
            this.musicChip.hide();
            this.pillSeparator.hide();
            this.pillBadge.hide();
            this.compact.remove_style_class_name('liquid-playing');
            this.root.remove_style_class_name('liquid-expanded');
            this.root.remove_style_class_name('liquid-preview-glow');
            this.surface.add_style_class_name('liquid-compact');
            this.backdrop.setVisible(false);
            this.root.hide();
        } else {
            this.syncPopup();
            this.updateMusic();
            this.updateClock();
            this.layout();
        }
        this.refreshTicker();
    }

    syncPopup() {
        const visible = !this.destroying && !this.hidden() && Boolean(this.expanded || this.closing || this.current);
        this.backdrop.setVisible(visible);
        this.root.visible = visible;
    }

    appearance() {
        const appearance = this.getSettingString('appearance', 'auto');
        this.dark = appearance === 'dark' || (appearance === 'auto' &&
            this.interface.get_string('color-scheme') === 'prefer-dark');
        for (const actor of [this.root, Main.uiGroup]) {
            actor.remove_style_class_name('liquid-light');
            actor.remove_style_class_name('liquid-dark');
            actor.add_style_class_name(this.dark ? 'liquid-dark' : 'liquid-light');
        }
        if (this.getSettingBool('desktop-style', true))
            Main.uiGroup.add_style_class_name('liquid-desktop');
        else
            Main.uiGroup.remove_style_class_name('liquid-desktop');

        // Apply custom glass opacity, corner radius & dynamic/custom accent color
        const opacity = Math.max(0.15, Math.min(0.90, this.getSettingDouble('glass-opacity', 0.42)));
        const radius = Math.max(14, Math.min(40, this.getSettingInt('corner-radius', 28)));
        const bgRgb = this.dark ? '18, 22, 32' : '255, 255, 255';
        this.surface.set_style(
            `background-color: rgba(${bgRgb}, ${opacity.toFixed(2)}); border-radius: ${radius}px;`
        );

        const useDynamicAccent = this.getSettingBool('dynamic-album-accent', true);
        const customAccent = this.getSettingString('custom-accent-color', '#5ac8fa');
        const albumAccent = (this.music?.state?.present ?? this.music?.state?.connected) && this.music?.state?.accentColor ?
            this.music.state.accentColor : null;
        this.activeAccentColor = (useDynamicAccent && albumAccent) ? albumAccent : (customAccent || '#5ac8fa');

        if (this.play) {
            this.play.set_style(
                `background-color: ${this.activeAccentColor}; color: #000000; ` +
                `box-shadow: 0 4px 18px ${hexToRgba(this.activeAccentColor, 0.55)};`
            );
        }
        if (this.nowPlayingTag)
            this.nowPlayingTag.set_style(`color: ${this.activeAccentColor} !important;`);
        if (this.compactTitle)
            this.compactTitle.set_style(`color: ${this.activeAccentColor};`);
        if (this.wave)
            this.wave.set_style(`color: ${this.activeAccentColor};`);
        if (this.osdBarFill)
            this.osdBarFill.set_style(`background-color: ${this.activeAccentColor};`);

        this.backdrop.update(this.expanded, radius);
    }

    layout(animate = false) {
        if (this.destroying)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const pillScale = Math.max(0.85, Math.min(1.30, this.getSettingDouble('pill-scale', 1.0)));
        const fontPx = Math.round(12 * pillScale);
        const padV = Math.round(4 * pillScale);
        const padH = Math.round(13 * pillScale);
        this.compact.set_style(
            `max-width: ${monitor.width < 1200 * scale ? 320 : 460}px; ` +
            `padding: ${padV}px ${padH}px; font-size: ${fontPx}px;`
        );

        if (this.hidden() || (!this.expanded && !this.closing && !this.current)) {
            this.backdrop.setVisible(false);
            this.root.hide();
            return;
        }
        this.backdrop.update(this.expanded);

        const configuredWidth = Math.max(360, Math.min(580, this.getSettingInt('island-width', 430)));
        const width = Math.min(configuredWidth * scale, monitor.width - 32 * scale);
        const offsetY = Math.max(0, Math.min(28, this.getSettingInt('island-offset-y', 8)));
        const [, panelY] = Main.panel.get_transformed_position();
        const y = panelY + Main.panel.height + offsetY * scale;

        this.history.height = Math.max(80 * scale, Math.min(250 * scale,
            monitor.height - Main.panel.height - 320 * scale));
        const height = this.surface.get_preferred_height(width)[1];

        const pos = this.getSettingString('island-position', 'center');
        let targetX;
        if (pos === 'left') {
            targetX = monitor.x + 16 * scale;
        } else if (pos === 'right') {
            targetX = monitor.x + monitor.width - width - 16 * scale;
        } else {
            const monitorCenterX = monitor.x + monitor.width / 2;
            targetX = monitorCenterX - width / 2;
        }
        const x = Math.round(Math.max(monitor.x + 12 * scale, Math.min(
            targetX, monitor.x + monitor.width - width - 12 * scale)));

        const target = `${width}:${height}:${x}:${y}`;
        if (target === this.layoutTarget)
            return;
        this.layoutTarget = target;
        // Geometry updates must not stop the popup dismissal/opening.
        for (const property of ['width', 'height', 'x', 'y'])
            this.root.remove_transition(property);
        this.root.ease({
            width,
            height,
            x,
            y,
            duration: animate ? this.animDuration(260) : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    toggle() {
        if (this.hidden())
            return;
        if (this.expanded) {
            this.close(true);
            return;
        }
        this.cancelPopupAnimation();
        this.closing = false;
        this.savedFocus = global.stage.get_key_focus();
        this.expanded = true;
        this.syncPopup();
        this.life.cancel(this.previewId);
        this.preview.hide();
        this.content.show();
        this.root.add_style_class_name('liquid-expanded');
        this.surface.remove_style_class_name('liquid-compact');
        this.syncQuickToggles();
        this.renderQuickApps();
        this.updateTelemetry(this.telemetryState);
        this.updateMusic();
        this.updateClock();
        if (this.activeTab === 'notifications')
            this.renderHistory();
        else
            this.renderCalendarGrid();

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (this.animationsEnabled()) {
            this.root.translation_y = -14 * scale;
            this.root.scale_y = 0.92;
            this.root.opacity = 0;
            this.layout(false);
            this.root.ease({
                translation_y: 0,
                scale_y: 1.0,
                opacity: 255,
                duration: this.animDuration(260),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this.layout(false);
        }
        this.music?.refreshPosition();
    }

    close(animate = true) {
        if (!this.expanded && !this.closing)
            return;
        const generation = this.cancelPopupAnimation();
        this.expanded = false;
        this.closing = true;
        if (!this.hidden() && this.savedFocus?.get_stage())
            this.savedFocus.grab_key_focus();
        this.savedFocus = null;

        const finalizeClose = () => {
            if (!this.life.alive || this.destroying || generation !== this.animationGeneration)
                return;
            this.closing = false;
            this.content.hide();
            this.root.remove_style_class_name('liquid-expanded');
            this.surface.add_style_class_name('liquid-compact');
            this.root.translation_y = 0;
            this.root.scale_y = 1;
            this.root.scale_x = 1;
            this.root.opacity = 255;
            this.layoutTarget = null;
            if (this.current) {
                this.preview.show();
                this.armPreview();
            }
            this.syncPopup();
            this.layout(false);
            this.nextPreview();
        };

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (animate && !this.hidden() && this.root.visible && this.animationsEnabled()) {
            this.root.ease({
                translation_y: -10 * scale,
                scale_y: 0.94,
                opacity: 0,
                duration: this.animDuration(180),
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: finalizeClose,
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

    syncPlayerSelector(state) {
        const players = state.players ?? [];
        this.playerSelector.visible = players.length > 1;
        const signature = JSON.stringify(players.map(player => [player.name, player.identity, player.selected]));
        if (signature === this.playerSelectorSignature)
            return;
        this.playerSelectorSignature = signature;
        this.playerSelector.destroy_all_children();
        if (players.length < 2)
            return;
        for (const player of players) {
            const name = plainText(player.identity || player.name);
            const choice = new St.Button({
                can_focus: true,
                x_expand: true,
                style_class: `liquid-aio-action-btn${player.selected ? ' liquid-tab-active' : ''}`,
                accessible_name: `Reproductor: ${name}${player.selected ? ', seleccionado' : ''}`,
                child: label(`${player.selected ? '✓ ' : ''}${name}`),
            });
            choice.connect('clicked', () => this.music?.selectPlayer(player.name));
            this.playerSelector.add_child(choice);
        }
    }

    updateMusic() {
        const state = this.music?.state;
        if (!state)
            return;
        const connected = Boolean(state.connected);
        const present = Boolean(state.present ?? state.connected);
        const showMusic = present && this.getSettingBool('music-show-island', true);
        const isPlaying = Boolean(present && state.playing);
        this.syncPlayerSelector(state);
        this.nowPlayingTag.text = plainText(state.identity || 'REPRODUCTOR');

        this.title.text = present ? plainText(state.title || state.identity || 'Reproductor') : 'Reproductor';
        this.artist.text = present ? plainText(state.artist || (connected ? 'Sin reproducción activa' : 'Conectando…')) : 'Sin reproducción activa';
        if (this.album) {
            this.album.text = plainText(state.album);
            this.album.visible = Boolean(state.album && present);
        }
        for (const actor of [this.smallCover, this.cover]) {
            if (state.cover && actor.gicon !== state.cover)
                actor.gicon = state.cover;
            else if (!state.cover && actor.icon_name !== 'audio-x-generic-symbolic')
                actor.icon_name = 'audio-x-generic-symbolic';
        }
        this.play.child.icon_name = state.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this.play.accessible_name = state.playing ? 'Pausar' : 'Reproducir';
        for (const [actor, enabled] of [
            [this.play, state.playing ? state.canPause : state.canPlay],
            [this.previous, state.canPrevious],
            [this.next, state.canNext],
            [this.slider, state.canSeek && state.length > 0],
            [this.raiseBtn, state.connected],
        ]) {
            actor.reactive = Boolean(enabled);
            actor.can_focus = Boolean(enabled);
            if (enabled)
                actor.remove_style_pseudo_class('insensitive');
            else
                actor.add_style_pseudo_class('insensitive');
        }

        // Keep OSD chip and Music chip cleanly separated so OSD never overwrites track title/cover
        if (this.event) {
            this.musicChip.visible = false;
            this.osdChip.visible = true;
            this.pillSeparator.visible = true;
        } else {
            this.osdChip.visible = false;
            this.musicChip.visible = showMusic && !this.hidden();
            this.pillSeparator.visible = showMusic && !this.hidden();
        }

        this.compactTitle.text = plainText(state.title || state.identity || 'Reproductor');
        if (showMusic && isPlaying && !this.hidden()) {
            this.wave.text = '▂▅▃';
            this.compact.add_style_class_name('liquid-playing');
            this.root.add_style_class_name('liquid-playing');
        } else {
            this.wave.text = 'Ⅱ';
            this.compact.remove_style_class_name('liquid-playing');
            this.root.remove_style_class_name('liquid-playing');
        }

        this.player.visible = showMusic;
        this.playerDivider.visible = showMusic;

        this.appearance();
        this.updateNotifBadge();
        this.progress();
        this.refreshTicker();
        if (this.expanded && this.activeTab === 'notifications')
            this.renderHistory();
        this.layout();
    }

    updateNotifBadge() {
        const count = this.notifications?.list().length ?? 0;
        this.notifTabBtn.label = count > 0 ? `🔔 Notificaciones (${count})` : '🔔 Notificaciones';
        if (this.clearAllBtn)
            this.clearAllBtn.visible = count > 0;
        if (this.pillBadge) {
            const hasUnread = count > 0 && !this.musicChip.visible && !this.event && !this.hidden();
            this.pillBadge.text = count > 0 ? `• ${count}` : '';
            this.pillBadge.visible = hasUnread;
        }
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
        const shouldTick = this.life.alive && this.compact.mapped && !this.hidden() &&
            this.getSettingBool('music-show-island', true) && this.music?.state?.playing;
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
            if (!this.current && !this.event && this.animationsEnabled())
                this.wave.text = ['▂▅▃', '▅▂▆', '▃▆▂'][this.waveStep++ % 3];
            this.refreshTicker();
        });
    }

    notification(notification, present) {
        if (!this.getSettingBool('show-banners', true) && notification.urgency !== 3) {
            this.updateNotifBadge();
            return;
        }
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
        if (this.expanded || this.closing || this.current || this.hidden())
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
        this.preview.add_child(this.notificationCard(n, true));
        this.preview.visible = !this.expanded && !this.closing;
        if (this.closing)
            return;

        const wasVisible = this.root.visible;
        this.cancelPopupAnimation();
        this.syncPopup();

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (!wasVisible && this.animationsEnabled()) {
            this.root.translation_y = -18 * scale;
            this.root.scale_y = 0.88;
            this.root.scale_x = 0.95;
            this.root.opacity = 0;
            this.layout(false);
            this.root.add_style_class_name('liquid-preview-glow');
            this.root.ease({
                translation_y: 0,
                scale_y: 1.0,
                scale_x: 1.0,
                opacity: 255,
                duration: this.animDuration(320),
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
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
        const current = this.current;
        if (this.expanded || this.closing) {
            this.finalizeClearPreview(current);
            return;
        }
        const generation = this.cancelPopupAnimation();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (animate && !this.hidden() && this.root.visible && this.animationsEnabled()) {
            this.root.ease({
                translation_y: -14 * scale,
                scale_y: 0.9,
                opacity: 0,
                duration: this.animDuration(200),
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    if (this.life.alive && !this.destroying && generation === this.animationGeneration)
                        this.finalizeClearPreview(current);
                },
            });
        } else {
            this.finalizeClearPreview(current);
        }
    }

    finalizeClearPreview(current = this.current) {
        if (current !== this.current)
            return;
        this.current = null;
        this.preview.destroy_all_children();
        this.preview.hide();
        this.root.remove_style_class_name('liquid-preview-glow');
        if (this.closing)
            return;
        this.cancelPopupAnimation();
        this.syncPopup();
        this.nextPreview();
    }

    openNotification(n) {
        if (!n || n._destroyed)
            return;
        n.acknowledged = true;
        try {
            n.activate();
        } catch (e) {
            console.debug(e);
        }
        try {
            if (typeof n.source?.open === 'function')
                n.source.open();
            else if (typeof n.source?.openApp === 'function')
                n.source.openApp();
            else if (n.source?.app)
                n.source.app.activate();
        } catch (e) {
            console.debug(e);
        }
        this.close(false);
        if (this.current?.notification === n)
            this.clearPreview(false);
    }

    notificationCard(n, preview = false) {
        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-notification',
            reactive: true,
            x_expand: true,
        });

        const heading = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const sourceIcon = n.source.icon ?
            new St.Icon({gicon: n.source.icon, icon_size: 16, style_class: 'liquid-notif-icon'}) :
            new St.Icon({icon_name: 'dialog-information-symbolic', icon_size: 16, style_class: 'liquid-notif-icon'});

        const mainTrigger = new St.Button({
            can_focus: true,
            x_expand: true,
            style_class: 'liquid-notification-card',
            accessible_name: `Abrir notificación de ${plainText(n.source.title)}`,
        });
        const titleRow = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
        titleRow.add_child(sourceIcon);
        const titleLabel = label(plainText(n.title || n.source.title), 'liquid-title');
        titleLabel.x_expand = true;
        titleRow.add_child(titleLabel);
        mainTrigger.set_child(titleRow);
        mainTrigger.connect('clicked', () => this.openNotification(n));
        heading.add_child(mainTrigger);

        const closeBtn = button('window-close-symbolic', 'Descartar notificación', () => {
            if (!n._destroyed)
                n.destroy();
            if (preview)
                this.clearPreview(true);
        }, 'liquid-aio-action-btn');
        heading.add_child(closeBtn);
        card.add_child(heading);

        if (n.body) {
            const bodyBtn = new St.Button({
                can_focus: false,
                x_expand: true,
                style_class: 'liquid-notification-card',
            });
            const body = label(plainText(n.body));
            body.clutter_text.line_wrap = true;
            body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            body.clutter_text.set_single_line_mode(false);
            body.set_style('max-height: 60px;');
            bodyBtn.set_child(body);
            bodyBtn.connect('clicked', () => this.openNotification(n));
            card.add_child(bodyBtn);
        }

        if (n.actions.length) {
            const actions = new St.BoxLayout({style: 'spacing: 6px; padding-top: 4px;'});
            for (const action of n.actions.slice(0, 3)) {
                const actor = new St.Button({
                    label: plainText(action.label),
                    can_focus: true,
                    style_class: 'liquid-aio-action-btn',
                    x_expand: true,
                });
                actor.connect('clicked', () => {
                    if (!n._destroyed) {
                        n.acknowledged = true;
                        action.activate();
                    }
                    this.close(false);
                    if (preview)
                        this.clearPreview(false);
                });
                actions.add_child(actor);
            }
            card.add_child(actions);
        }
        return card;
    }

    historyChanged() {
        if (this.current && !this.current.notification.source.notifications.includes(this.current.notification))
            this.clearPreview(true);
        this.queue = this.queue.filter(item => !item.notification._destroyed);
        this.updateNotifBadge();
        if (this.expanded && this.activeTab === 'notifications') {
            this.life.cancel(this.historyId);
            this.historyId = this.life.after(80, () => this.renderHistory());
        }
        if (!this.current && !this.event)
            this.updateMusic();
    }

    renderHistory() {
        this.historyBox.destroy_all_children();
        const notifications = this.notifications?.list() ?? [];
        this.updateNotifBadge();
        if (!notifications.length) {
            const emptyBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 4px; padding: 14px 8px;',
            });
            emptyBox.add_child(new St.Icon({
                icon_name: 'emblem-ok-symbolic',
                icon_size: 20,
                style_class: 'liquid-empty-icon',
            }));
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

        this.osdIcon.gicon = event.gicon ?? null;
        if (!event.gicon)
            this.osdIcon.icon_name = event.icon || 'dialog-information-symbolic';
        this.osdTitle.text = event.title || '';

        if (event.level != null) {
            const pct = Math.max(0, Math.min(100, Math.round(event.level * 100)));
            const barWidth = Math.max(4, Math.round((pct / 100) * 68));
            this.osdBarTrack.visible = true;
            this.osdBarFill.remove_all_transitions();
            this.osdBarFill.ease({
                width: barWidth,
                duration: this.animDuration(140),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this.osdPercent.text = `${pct}%`;
            this.osdPercent.visible = true;
        } else {
            this.osdBarTrack.visible = false;
            this.osdPercent.text = event.detail || '';
            this.osdPercent.visible = Boolean(event.detail);
        }

        this.musicChip.visible = false;
        this.osdChip.visible = true;
        this.pillSeparator.visible = true;
        this.layout(true);

        this.eventId = this.life.after(event.key === 'battery' ? 4000 : 1700, () => {
            this.event = null;
            this.osdChip.visible = false;
            this.updateMusic();
            this.nextPreview();
        });
        return true;
    }

    destroy() {
        this.destroying = true;
        this.cancelPopupAnimation();
        this.backdrop.setVisible(false);
        this.life.destroy();
        this.queue = [];
        this.current = null;
        this.music = null;
        this.notifications = null;
        this.telemetry = null;
        this.wallClock = null;
        this.interface = null;
        this.notifSettings = null;
        this.cover = null;
        this.calGridLayout = null;

        if (Main.panel.statusArea.dateMenu?.container)
            Main.panel.statusArea.dateMenu.container.show();

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
