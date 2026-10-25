import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Lifetime} from './lifecycle.js';
import {Backdrop} from './backdrop.js';
import {WidgetProviders} from './widgetProviders.js';
import {WIDGET_TYPES, clampWidget, parseWidgetLayout, parseWidgetTasks,
    resolveWidget, timerRemaining} from './widgetLayout.js';

export {WIDGET_TYPES} from './widgetLayout.js';

const STOP = Clutter.EVENT_STOP;
const PASS = Clutter.EVENT_PROPAGATE;
const text = (value, fallback = '') => String(value ?? fallback);
const label = (value, style = '') => {
    const actor = new St.Label({text: text(value),
        style_class: `liquid-widget-text ${style}`, x_expand: true});
    actor.clutter_text.line_wrap = true;
    return actor;
};
const localDay = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export class Widgets {
    constructor(settings, {music, telemetry, openPreferences, interfaceSettings, wallClock} = {}) {
        this.settings = settings;
        this.interfaceSettings = interfaceSettings;
        this.overviewActive = Boolean(Main.overview.visible);
        this.music = music;
        this.telemetryService = telemetry;
        this.telemetry = telemetry?.state ?? telemetry ?? {};
        this.openPreferences = openPreferences;
        this.life = new Lifetime();
        this.records = new Map();
        this.tickSource = 0;
        this.timerDeadline = null;
        this.timerSeconds = settings.get_int('widget-timer-seconds');
        this.layout = parseWidgetLayout(settings.get_string('widget-layout'));
        this.providers = new WidgetProviders(settings, () => this.renderData());
        this.layer = new St.Widget({name: 'liquid-native-widgets', reactive: false,
            layout_manager: new Clutter.FixedLayout()});
        // Shell 50 layout.js puts this Meta.BackgroundGroup at the bottom of
        // global.window_group. Its children stay below every application window.
        // Do not use addChrome(): desktop cards must never overlay applications.
        const background = Main.layoutManager._backgroundGroup;
        if (!background)
            throw new Error('GNOME Shell desktop background group is unavailable');
        background.add_child(this.layer);
        this.life.connect(Main.layoutManager, 'monitors-changed', () => this.relayout());
        this.life.connect(global.display, 'in-fullscreen-changed', () => this.syncVisibility());
        this.life.connect(Main.overview, 'showing', () => { this.overviewActive = true; this.syncVisibility(); });
        this.life.connect(Main.overview, 'hidden', () => { this.overviewActive = false; this.syncVisibility(); });
        this.life.connect(Main.sessionMode, 'updated', () => this.syncVisibility());
        this.life.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => this.relayout());
        this.life.connect(this.layer, 'notify::mapped', () => this.syncTicks());
        this.life.connect(settings, 'changed', (_s, key) => this.settingChanged(key));
        if (interfaceSettings)
            this.life.connect(interfaceSettings, 'changed::color-scheme', () => this.appearance());
        if (wallClock)
            this.life.connect(wallClock, 'notify::clock', () => { if (this.layer.visible) this.renderTime(); });
        this.unsubscribe = music?.subscribe?.(() => {
            this.syncVisibility();
            this.renderMusic();
        });
        Main.ctrlAltTabManager.addGroup(this.layer, 'Widgets del escritorio', 'view-grid-symbolic');
        this.syncWidgets();
    }

    settingChanged(key) {
        if (['appearance', 'glass-opacity', 'corner-radius', 'custom-accent-color', 'dynamic-album-accent'].includes(key)) {
            this.appearance();
            this.renderMusic();
        }
        else if (key === 'widgets-enabled')
            this.syncWidgets();
        else if (key === 'widget-layout') {
            if (!this.saving) {
                this.layout = parseWidgetLayout(this.settings.get_string(key));
                this.relayout();
            }
        } else if (key === 'widgets-edit-mode') {
            this.cancelGesture();
            this.syncEditing();
        } else if (key === 'music-show-widget')
            this.syncVisibility();
        else if (key === 'pinned-island-apps')
            this.rebuild('launchers');
        else if (key === 'widget-notes') {
            const entry = this.records.get('notes')?.entry;
            const value = this.settings.get_string(key);
            if (entry && entry.get_text() !== value)
                entry.set_text(value);
        } else if (key === 'widget-tasks' && !this.savingTasks)
            this.rebuild('tasks');
        else if (key === 'widget-timer-seconds' && this.timerDeadline === null) {
            this.timerSeconds = this.settings.get_int(key);
            this.renderTimer();
        }
    }

    monitors() {
        const manager = global.backend.get_monitor_manager();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return Main.layoutManager.monitors.map(monitor => {
            let connector = '';
            try {
                const logical = manager.get_logical_monitors().find(m => m.get_number() === monitor.index);
                connector = logical?.get_monitors().map(m => m.get_connector()).sort()[0] ?? '';
            } catch (_) { /* Connector API unavailable: recover by index. */ }
            return {index: monitor.index, connector: connector || `monitor-${monitor.index}`,
                primary: monitor.index === Main.layoutManager.primaryIndex,
                x: monitor.x, y: monitor.y, width: monitor.width / scale,
                height: monitor.height / scale, scale};
        });
    }

    syncWidgets() {
        const enabled = new Set(this.settings.get_strv('widgets-enabled').filter(type => Object.hasOwn(WIDGET_TYPES, type)));
        for (const [type, record] of this.records) {
            if (!enabled.has(type)) {
                if (this.gesture?.record === record || this.keyboardGesture?.record === record)
                    this.cancelGesture();
                this.flushNote(record);
                record.life.destroy();
                record.backdrop.destroy();
                record.actor.destroy();
                this.records.delete(type);
            }
        }
        for (const type of enabled) {
            if (!this.records.has(type))
                this.createWidget(type);
        }
        this.syncEditing();
        this.appearance();
        this.relayout();
        this.renderData();
    }

    rebuild(type) {
        const record = this.records.get(type);
        if (!record)
            return;
        if (this.gesture?.record === record || this.keyboardGesture?.record === record)
            this.cancelGesture();
        record.life.destroy();
        record.backdrop.destroy();
        record.actor.destroy();
        this.records.delete(type);
        this.createWidget(type);
        this.syncEditing();
        this.appearance();
        this.relayout();
        this.renderData();
    }

    createWidget(type) {
        const spec = WIDGET_TYPES[type];
        const actor = new St.Widget({style_class: 'liquid-widget', reactive: true,
            accessible_name: spec.title, layout_manager: new Clutter.BinLayout()});
        this.layer.add_child(actor);
        const box = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true,
            style_class: 'liquid-widget-content'});
        actor.add_child(box);
        const record = {type, actor, box, life: new Lifetime(), backdrop: new Backdrop(actor, this.settings)};
        this.records.set(type, record);
        const header = new St.BoxLayout({style_class: 'liquid-widget-header'});
        const grip = this.button(spec.title, 'input-mouse-symbolic', () => {}, 'Mover widget con flechas; Mayús para cambiar tamaño');
        grip.add_style_class_name('liquid-widget-grip');
        grip.x_expand = true;
        header.add_child(grip);
        const config = this.button('', 'emblem-system-symbolic', () => this.openPreferences?.(), 'Configurar widgets');
        header.add_child(config);
        box.add_child(header);
        record.header = header;
        record.grip = grip;
        const content = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true,
            style_class: 'liquid-widget-body'});
        const scroll = new St.ScrollView({x_expand: true, y_expand: true,
            overlay_scrollbars: true, hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC});
        scroll.set_child(content);
        box.add_child(scroll);
        record.content = content;
        const resize = this.button('', 'view-fullscreen-symbolic', () => {}, 'Cambiar tamaño del widget con flechas');
        resize.add_style_class_name('liquid-widget-resize');
        resize.x_align = Clutter.ActorAlign.END;
        resize.y_align = Clutter.ActorAlign.END;
        actor.add_child(resize);
        record.resize = resize;
        for (const [handle, sizing] of [[grip, false], [resize, true]]) {
            record.life.connect(handle, 'button-press-event', (_actor, event) => this.beginGesture(record, event, sizing));
            record.life.connect(handle, 'key-press-event', (_actor, event) => this.keyGesture(record, event, sizing));
            record.life.connect(handle, 'key-release-event', (_actor, event) => {
                if (this.isArrow(event.get_key_symbol()) && this.keyboardGesture?.record === record) {
                    this.keyboardGesture = null;
                    this.saveRecord(record);
                    return STOP;
                }
                return PASS;
            });
            record.life.connect(handle, 'key-focus-out', () => {
                if (this.keyboardGesture?.record === record) {
                    this.keyboardGesture = null;
                    this.saveRecord(record);
                }
            });
        }
        this.buildContent(record);
    }

    button(title, icon, callback, name = title) {
        const row = new St.BoxLayout({style_class: 'liquid-widget-button-row'});
        if (icon)
            row.add_child(new St.Icon({icon_name: icon, icon_size: 18}));
        if (title)
            row.add_child(label(title));
        const button = new St.Button({child: row, can_focus: true, reactive: true,
            accessible_name: name, style_class: 'liquid-widget-button'});
        button.connect('clicked', callback);
        return button;
    }

    buildContent(r) {
        const addLabel = (key, value, style = '') => {
            r[key] = label(value, style);
            r.content.add_child(r[key]);
        };
        if (r.type === 'clock') {
            addLabel('time', '', 'liquid-widget-large');
            addLabel('date', '');
        } else if (r.type === 'calendar') {
            addLabel('month', '');
            r.grid = new St.Widget({layout_manager: new Clutter.GridLayout(), x_expand: true});
            r.content.add_child(r.grid);
            r.agenda = new St.BoxLayout({vertical: true, style_class: 'liquid-widget-agenda'});
            r.content.add_child(r.agenda);
        } else if (r.type === 'weather') {
            r.icon = new St.Icon({icon_name: 'weather-clear-symbolic', icon_size: 34});
            r.content.add_child(r.icon);
            addLabel('temperature', '—', 'liquid-widget-large');
            addLabel('location', '');
            addLabel('status', '');
            const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Weather.desktop');
            if (app)
                r.content.add_child(this.button('Abrir Clima', '', () => app.activate()));
        } else if (['cpu', 'ram', 'gpu'].includes(r.type)) {
            addLabel('heading', r.type === 'cpu' ? 'CPU' : r.type === 'gpu' ? 'GPU' : 'Memoria');
            addLabel('value', '—', 'liquid-widget-large');
            addLabel('detail', '');
        } else if (r.type === 'music') {
            const top = new St.BoxLayout({style_class: 'liquid-widget-music-top'});
            r.cover = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 64});
            top.add_child(r.cover);
            const info = new St.BoxLayout({vertical: true, x_expand: true});
            r.title = label('Música', 'liquid-widget-heading');
            r.artist = label('');
            info.add_child(r.title);
            info.add_child(r.artist);
            top.add_child(info);
            const open = new St.Button({child: top, can_focus: true, reactive: true,
                accessible_name: 'Abrir reproductor', style_class: 'liquid-widget-button'});
            open.connect('clicked', () => this.music?.raise?.());
            r.content.add_child(open);
            const controls = new St.BoxLayout({style_class: 'liquid-widget-controls'});
            r.previous = this.button('', 'media-skip-backward-symbolic', () => this.music?.command('Previous'), 'Pista anterior');
            r.play = this.button('', 'media-playback-start-symbolic', () => this.music?.command('PlayPause'), 'Reproducir o pausar');
            r.next = this.button('', 'media-skip-forward-symbolic', () => this.music?.command('Next'), 'Pista siguiente');
            for (const button of [r.previous, r.play, r.next])
                controls.add_child(button);
            r.content.add_child(controls);
            r.progress = new Slider.Slider(0);
            r.progress.accessible_name = 'Posición de reproducción';
            r.life.connect(r.progress, 'drag-begin', () => { r.scrubbing = true; });
            r.life.connect(r.progress, 'drag-end', () => {
                r.scrubbing = false;
                this.music?.seek(r.progress.value);
            });
            r.life.connect(r.progress, 'notify::value', () => {
                if (!r.syncingProgress && !r.scrubbing)
                    this.music?.seek(r.progress.value);
            });
            r.content.add_child(r.progress);
            addLabel('elapsed', '');
            r.players = new St.BoxLayout({vertical: true});
            r.content.add_child(r.players);
        } else if (r.type === 'launchers') {
            addLabel('heading', 'Aplicaciones', 'liquid-widget-heading');
            const ids = this.settings.get_strv('pinned-island-apps').slice(0, 10);
            let available = 0;
            for (const id of ids) {
                const app = Shell.AppSystem.get_default().lookup_app(id);
                if (!app)
                    continue;
                available++;
                const button = this.button(app.get_name(), '', () => app.activate());
                button.get_child().insert_child_at_index(app.create_icon_texture(24), 0);
                r.content.add_child(button);
            }
            if (!available)
                addLabel('empty', ids.length ? 'Las aplicaciones fijadas no están disponibles' : 'Elegí aplicaciones en Preferencias');
        } else if (r.type === 'notes') {
            addLabel('heading', 'Notas', 'liquid-widget-heading');
            r.entry = new St.Entry({text: this.settings.get_string('widget-notes'), can_focus: true,
                hint_text: 'Escribí una nota…', accessible_name: 'Nota local',
                x_expand: true, y_expand: true, style_class: 'liquid-widget-entry'});
            r.entry.clutter_text.single_line_mode = false;
            r.entry.clutter_text.line_wrap = true;
            r.content.add_child(r.entry);
            const save = () => {
                const value = r.entry.get_text();
                if (this.settings.get_string('widget-notes') !== value)
                    this.settings.set_string('widget-notes', value);
            };
            r.life.connect(r.entry.clutter_text, 'key-focus-out', save);
            // Debounce local text persistence so a disable does not lose edits.
            r.life.connect(r.entry.clutter_text, 'text-changed', () => {
                r.life.cancel(r.noteSave);
                r.noteSave = r.life.after(500, save);
            });
        } else if (r.type === 'tasks') {
            addLabel('heading', 'Tareas', 'liquid-widget-heading');
            r.tasks = parseWidgetTasks(this.settings.get_string('widget-tasks'));
            r.taskList = new St.BoxLayout({vertical: true});
            r.content.add_child(r.taskList);
            this.renderTasks(r);
            r.entry = new St.Entry({hint_text: 'Nueva tarea…', can_focus: true,
                accessible_name: 'Nueva tarea local', style_class: 'liquid-widget-entry'});
            r.content.add_child(r.entry);
            r.life.connect(r.entry.clutter_text, 'activate', () => {
                const value = r.entry.get_text().trim();
                if (!value || r.tasks.length >= 100)
                    return;
                r.tasks.push({id: GLib.uuid_string_random(), text: value.slice(0, 1000), done: false});
                r.entry.set_text('');
                this.saveTasks(r);
                this.renderTasks(r);
            });
        } else if (r.type === 'timer') {
            addLabel('heading', 'Temporizador', 'liquid-widget-heading');
            addLabel('remaining', '', 'liquid-widget-large');
            const row = new St.BoxLayout({style_class: 'liquid-widget-controls'});
            r.start = this.button('Iniciar', '', () => this.toggleTimer());
            row.add_child(r.start);
            row.add_child(this.button('Reiniciar', '', () => {
                this.timerDeadline = null;
                this.timerSeconds = this.settings.get_int('widget-timer-seconds');
                this.renderTimer();
                this.syncTicks();
            }));
            r.content.add_child(row);
            addLabel('status', '');
        } else if (r.type === 'discord') {
            addLabel('heading', 'Discord', 'liquid-widget-heading');
            const apps = Shell.AppSystem.get_default();
            const app = apps.lookup_app('com.discordapp.Discord.desktop') ?? apps.lookup_app('discord.desktop');
            if (app)
                r.content.add_child(this.button('Abrir Discord', '', () => app.activate()));
            else
                addLabel('unavailable', 'Discord no está instalado');
            addLabel('status', 'Controles de voz no disponibles: no hay una integración verificada.');
        }
    }

    renderTasks(r) {
        r.taskList.destroy_all_children();
        for (const task of r.tasks) {
            const button = this.button(`${task.done ? '☑' : '☐'} ${task.text}`, '', () => {
                task.done = !task.done;
                this.saveTasks(r);
                this.renderTasks(r);
            }, `${task.done ? 'Marcar pendiente' : 'Completar'}: ${task.text}`);
            r.taskList.add_child(button);
        }
    }

    saveTasks(r) {
        this.savingTasks = true;
        try { this.settings.set_string('widget-tasks', JSON.stringify(r.tasks)); }
        finally { this.savingTasks = false; }
    }

    activateApp(...ids) {
        const apps = Shell.AppSystem.get_default();
        const app = ids.map(id => apps.lookup_app(id)).find(Boolean);
        app?.activate();
    }

    appearance() {
        const choice = this.settings.get_string('appearance');
        const light = choice === 'light' || (choice === 'auto' &&
            this.interfaceSettings?.get_string('color-scheme') !== 'prefer-dark');
        const radius = this.settings.get_int('corner-radius');
        const opacity = this.settings.get_double('glass-opacity');
        for (const r of this.records.values()) {
            if (light) r.actor.add_style_class_name('liquid-widget-light');
            else r.actor.remove_style_class_name('liquid-widget-light');
            r.actor.set_style(`border-radius: ${radius}px; background-color: rgba(${light ? '235,240,250' : '20,24,34'},${opacity});`);
            r.backdrop.update(false, radius);
        }
    }

    syncEditing() {
        const edit = this.settings.get_boolean('widgets-edit-mode');
        for (const r of this.records.values()) {
            r.header.visible = edit;
            r.resize.visible = edit;
            if (edit)
                r.actor.add_style_class_name('liquid-widget-editing');
            else
                r.actor.remove_style_class_name('liquid-widget-editing');
        }
    }

    relayout() {
        if (this.gesture)
            this.cancelGesture();
        const monitors = this.monitors();
        let order = 0;
        this.layer.set_size(global.stage.width, global.stage.height);
        // Backgrounds may have been recreated for a monitor change.
        this.layer.get_parent()?.set_child_above_sibling(this.layer, null);
        for (const r of this.records.values()) {
            const placement = resolveWidget(r.type, this.layout.widgets[r.type], monitors, order++);
            if (!placement)
                continue;
            r.monitor = placement.monitor;
            r.rect = placement.rect;
            this.place(r);
        }
        this.syncVisibility();
    }

    place(r) {
        const {monitor: m, rect} = r;
        r.actor.set_position(Math.round(m.x + rect.x * m.scale), Math.round(m.y + rect.y * m.scale));
        r.actor.set_size(Math.round(rect.width * m.scale), Math.round(rect.height * m.scale));
        // Content scrolls within its allocation; leave the glass shadow unclipped.
    }

    syncVisibility() {
        const visible = !this.overviewActive && !Main.overview.visible && !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        this.layer.visible = visible;
        const edit = this.settings.get_boolean('widgets-edit-mode');
        for (const r of this.records.values()) {
            const fullscreen = r.monitor && global.display.get_monitor_in_fullscreen(r.monitor.index);
            const musicVisible = r.type !== 'music' || (this.settings.get_boolean('music-show-widget') &&
                (edit || Boolean(this.music?.state?.present ?? this.music?.state?.connected)));
            r.actor.visible = visible && !fullscreen && musicVisible;
            r.backdrop.setVisible(r.actor.visible);
        }
        if (!visible || (this.gesture && !this.gesture.record.actor.visible) ||
            (this.keyboardGesture && !this.keyboardGesture.record.actor.visible))
            this.cancelGesture();
        this.providers.setActive(this.records.keys(), visible && Boolean(this.records.get('weather')?.actor.visible));
        this.telemetryService?.setGpuEnabled?.(Boolean(this.records.get('gpu')?.actor.visible));
        this.syncTicks();
    }

    syncTicks() {
        const visible = this.layer?.mapped && [...this.records.values()].some(r =>
            r.actor.visible && ((r.type === 'timer' && this.timerDeadline !== null) || (r.type === 'music' && this.music?.state?.playing)));
        if (!visible) {
            this.life.cancel(this.tickSource);
            this.tickSource = 0;
            return;
        }
        this.renderTime();
        if (!this.tickSource) {
            this.tickSource = this.life.timeoutSeconds(1, () => {
                this.renderTime();
                this.renderMusicProgress();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    renderData() {
        this.renderTime();
        this.renderCalendar();
        this.renderMusic();
        this.setTelemetry(this.telemetry);
        const r = this.records.get('weather');
        if (r) {
            const state = this.providers.weather;
            r.temperature.text = state.temperature || '—';
            r.location.text = state.location || 'Clima';
            r.status.text = state.message || '';
            r.icon.icon_name = state.icon;
        }
    }

    renderTime() {
        const now = GLib.DateTime.new_now_local();
        const r = this.records.get('clock');
        if (r?.actor.visible) {
            const format = this.settings.get_boolean('clock-use-24h') ? '%H:%M' : '%I:%M %p';
            r.time.text = now.format(this.settings.get_boolean('clock-show-seconds') ? format.replace('%M', '%M:%S') : format);
            r.date.text = now.format('%A, %e de %B');
        }
        const day = now.format('%F');
        if (this.day !== day) {
            this.day = day;
            this.providers.requestMonth();
            this.renderCalendar();
        }
        this.renderTimer();
    }

    renderCalendar() {
        const r = this.records.get('calendar');
        if (!r)
            return;
        const today = new Date();
        r.month.text = GLib.DateTime.new_now_local().format('%B %Y');
        r.grid.destroy_all_children();
        const layout = r.grid.layout_manager;
        for (let i = 0; i < 7; i++)
            layout.attach(label(['L', 'M', 'X', 'J', 'V', 'S', 'D'][i], 'liquid-widget-day'), i, 0, 1, 1);
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        first.setDate(first.getDate() - (first.getDay() + 6) % 7);
        const eventDays = new Set();
        for (const event of this.providers.calendar.events) {
            const start = new Date(Math.max(event.start, first.getTime()));
            start.setHours(0, 0, 0, 0);
            for (let count = 0; count < 43 && start.getTime() < Math.max(event.end, event.start + 1); count++) {
                eventDays.add(localDay(start));
                start.setDate(start.getDate() + 1);
            }
        }
        for (let i = 0; i < 42; i++) {
            const date = new Date(first);
            date.setDate(first.getDate() + i);
            const dot = eventDays.has(localDay(date)) ? ' •' : '';
            const day = label(`${date.getDate()}${dot}`, 'liquid-widget-day');
            if (date.getMonth() !== today.getMonth())
                day.add_style_class_name('liquid-widget-dim');
            if (localDay(date) === localDay(today))
                day.add_style_class_name('liquid-widget-today');
            layout.attach(day, i % 7, Math.floor(i / 7) + 1, 1, 1);
        }
        r.agenda.destroy_all_children();
        const state = this.providers.calendar;
        const upcoming = state.events.filter(e => e.end >= Date.now()).slice(0, 3);
        if (!state.available)
            r.agenda.add_child(label(state.loading ? 'Cargando calendario…' : 'Sin calendarios disponibles. Configurá Calendario.'));
        else if (!upcoming.length)
            r.agenda.add_child(label('Sin próximos eventos'));
        for (const event of upcoming) {
            const date = GLib.DateTime.new_from_unix_local(Math.floor(event.start / 1000));
            r.agenda.add_child(label(`${date.format('%e/%m %H:%M')} · ${event.summary}`));
        }
    }

    renderMusic() {
        const r = this.records.get('music');
        if (!r)
            return;
        const state = this.music?.state ?? {};
        r.title.text = text(state.title || state.identity, 'Música');
        r.artist.text = text(state.artist || state.identity, 'Abrí un reproductor');
        if (state.cover)
            r.cover.gicon = state.cover;
        else
            r.cover.icon_name = 'audio-x-generic-symbolic';
        r.previous.reactive = Boolean(state.canPrevious);
        r.next.reactive = Boolean(state.canNext);
        r.play.reactive = Boolean(state.playing ? state.canPause : state.canPlay);
        for (const button of [r.previous, r.next, r.play]) {
            button.can_focus = button.reactive;
            button.opacity = button.reactive ? 255 : 105;
        }
        r.play.get_child().get_first_child().icon_name = state.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        const requestedAccent = this.settings.get_boolean('dynamic-album-accent') ? state.accentColor : this.settings.get_string('custom-accent-color');
        const accent = /^#[0-9a-f]{6}$/i.test(requestedAccent ?? '') ? requestedAccent : '#5ac8fa';
        r.play.set_style(`color: ${accent};`);
        r.progress.set_style(`-barlevel-active-background-color: ${accent};`);
        r.progress.reactive = Boolean(state.canSeek && state.length > 0);
        r.progress.can_focus = r.progress.reactive;
        this.renderMusicProgress();
        this.syncTicks();
        const players = this.music?.players ?? state.players ?? [];
        const key = JSON.stringify(players.map(p => [p.name ?? p.busName ?? p.id, p.identity]));
        if (key !== r.playerKey) {
            r.playerKey = key;
            r.players.destroy_all_children();
            if (players.length > 1) {
                for (const player of players) {
                    const id = player.name ?? player.busName ?? player.id;
                    r.players.add_child(this.button(player.identity || id, '', () => this.music?.selectPlayer?.(id)));
                }
            }
        }
    }

    renderMusicProgress() {
        const r = this.records.get('music');
        if (!r || !r.actor.visible || r.scrubbing)
            return;
        const state = this.music?.state;
        const position = this.music?.getPosition?.() ?? this.music?.position?.() ?? 0;
        r.syncingProgress = true;
        r.progress.value = state?.length > 0 ? Math.min(1, position / state.length) : 0;
        r.syncingProgress = false;
        const format = value => {
            const seconds = Math.floor(Math.max(0, value) / 1000000);
            return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        };
        r.elapsed.text = state?.length > 0 ? `${format(position)} / ${format(state.length)}` : '';
    }

    setTelemetry(state) {
        this.telemetry = state ?? {};
        for (const type of ['cpu', 'ram']) {
            const r = this.records.get(type);
            if (!r)
                continue;
            const value = this.telemetry[type];
            r.value.text = Number.isFinite(value) ? `${Math.round(value)}%` : '—';
            r.detail.text = type === 'cpu' && Number.isFinite(this.telemetry.temp) ? `${this.telemetry.temp} °C` : '';
        }
        const gpu = this.records.get('gpu');
        if (gpu) {
            const state = this.telemetry.gpu;
            const devices = state?.devices ?? [];
            const active = devices.find(device => device.utilization !== null) ?? devices[0];
            gpu.heading.text = active?.name || 'GPU';
            gpu.value.text = Number.isFinite(active?.utilization) ? `${Math.round(active.utilization)}%` : '—';
            const reason = {unsupported: 'El controlador no expone métricas de GPU',
                'no-device': 'No se detectó una GPU compatible', disabled: 'Monitoreo suspendido'};
            gpu.detail.text = state?.available ? devices.map(device => {
                const usage = Number.isFinite(device.utilization) ? `${Math.round(device.utilization)}%` : '—';
                const memory = Number.isFinite(device.memoryUsed) && Number.isFinite(device.memoryTotal)
                    ? ` · ${(device.memoryUsed / 1073741824).toFixed(1)} / ${(device.memoryTotal / 1073741824).toFixed(1)} GiB` : '';
                return `${device.name}: ${usage}${memory}`;
            }).join('\n') : reason[state?.reason] || 'Métricas de GPU no disponibles';
        }
    }

    toggleTimer() {
        const now = GLib.get_monotonic_time();
        if (this.timerDeadline !== null) {
            this.timerSeconds = timerRemaining(this.timerDeadline, now, 0);
            this.timerDeadline = null;
        } else {
            if (this.timerSeconds <= 0)
                this.timerSeconds = this.settings.get_int('widget-timer-seconds');
            this.timerDeadline = now + this.timerSeconds * GLib.TIME_SPAN_SECOND;
        }
        this.renderTimer();
        this.syncTicks();
    }

    renderTimer() {
        const r = this.records.get('timer');
        if (!r)
            return;
        const seconds = timerRemaining(this.timerDeadline, GLib.get_monotonic_time(), this.timerSeconds);
        r.remaining.text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        r.start.get_child().get_first_child().text = this.timerDeadline !== null && seconds > 0 ? 'Pausar' : 'Iniciar';
        if (this.timerDeadline !== null && seconds === 0) {
            this.timerDeadline = null;
            this.timerSeconds = 0;
        }
        r.status.text = seconds === 0 ? 'Tiempo cumplido' : '';
    }

    beginGesture(record, event, resize) {
        if (event.get_button() !== 1 || !this.settings.get_boolean('widgets-edit-mode'))
            return PASS;
        this.cancelGesture();
        (resize ? record.resize : record.grip).grab_key_focus();
        const [x, y] = event.get_coords();
        const grab = global.stage.grab(resize ? record.resize : record.grip);
        this.gesture = {record, resize, x, y, rect: {...record.rect}, monitor: record.monitor, grab};
        this.gestureSignal = global.stage.connect('captured-event', (_stage, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.cancelGesture();
                return STOP;
            }
            if (type === Clutter.EventType.MOTION) {
                this.moveGesture(ev);
                return STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE && ev.get_button() === 1) {
                const r = this.gesture.record;
                this.endGesture();
                this.saveRecord(r);
                return STOP;
            }
            return PASS;
        });
        return STOP;
    }

    moveGesture(event) {
        const g = this.gesture;
        const [x, y] = event.get_coords();
        const dx = (x - g.x) / g.monitor.scale;
        const dy = (y - g.y) / g.monitor.scale;
        const next = {...g.rect};
        let monitor = g.monitor;
        if (g.resize) {
            next.width += dx;
            next.height += dy;
        } else {
            const monitors = this.monitors();
            monitor = monitors.find(m => x >= m.x && x < m.x + m.width * m.scale &&
                y >= m.y && y < m.y + m.height * m.scale) ?? monitor;
            next.x = (g.monitor.x + g.rect.x * g.monitor.scale + x - g.x - monitor.x) / monitor.scale;
            next.y = (g.monitor.y + g.rect.y * g.monitor.scale + y - g.y - monitor.y) / monitor.scale;
        }
        g.record.monitor = monitor;
        g.record.rect = clampWidget(g.record.type, next, monitor, this.settings.get_boolean('widget-snap-to-grid'));
        this.place(g.record);
    }

    isArrow(key) {
        return [Clutter.KEY_Left, Clutter.KEY_Right, Clutter.KEY_Up, Clutter.KEY_Down].includes(key);
    }

    keyGesture(record, event, resize) {
        if (!this.settings.get_boolean('widgets-edit-mode'))
            return PASS;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape && this.keyboardGesture?.record === record) {
            record.rect = this.keyboardGesture.rect;
            this.keyboardGesture = null;
            this.place(record);
            return STOP;
        }
        if (!this.isArrow(key))
            return PASS;
        this.keyboardGesture ??= {record, rect: {...record.rect}};
        const sizing = resize || Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
        const step = this.settings.get_boolean('widget-snap-to-grid') ? 12 : 1;
        const next = {...record.rect};
        const dx = key === Clutter.KEY_Left ? -step : key === Clutter.KEY_Right ? step : 0;
        const dy = key === Clutter.KEY_Up ? -step : key === Clutter.KEY_Down ? step : 0;
        if (sizing) {
            next.width += dx;
            next.height += dy;
        } else {
            next.x += dx;
            next.y += dy;
        }
        record.rect = clampWidget(record.type, next, record.monitor);
        this.place(record);
        return STOP;
    }

    saveRecord(record) {
        this.layout.widgets[record.type] = {...record.rect};
        this.saving = true;
        try { this.settings.set_string('widget-layout', JSON.stringify(this.layout)); }
        finally { this.saving = false; }
    }

    endGesture() {
        if (this.gestureSignal)
            global.stage.disconnect(this.gestureSignal);
        this.gestureSignal = 0;
        this.gesture?.grab?.dismiss();
        this.gesture = null;
    }

    cancelGesture() {
        if (this.gesture) {
            const {record, rect, monitor} = this.gesture;
            record.rect = rect;
            record.monitor = monitor;
            this.place(record);
            this.endGesture();
        }
        if (this.keyboardGesture) {
            this.keyboardGesture.record.rect = this.keyboardGesture.rect;
            this.place(this.keyboardGesture.record);
            this.keyboardGesture = null;
        }
    }

    flushNote(record) {
        if (record.type === 'notes' && record.entry.get_text() !== this.settings.get_string('widget-notes'))
            this.settings.set_string('widget-notes', record.entry.get_text());
    }

    destroy() {
        this.cancelGesture();
        this.unsubscribe?.();
        this.telemetryService?.setGpuEnabled?.(false);
        this.providers.destroy();
        this.life.destroy();
        Main.ctrlAltTabManager.removeGroup(this.layer);
        for (const r of this.records.values()) {
            // Persist any note still inside its debounce window on disable.
            this.flushNote(r);
            r.life.destroy();
            r.backdrop.destroy();
        }
        this.records.clear();
        this.layer.destroy();
    }
}
