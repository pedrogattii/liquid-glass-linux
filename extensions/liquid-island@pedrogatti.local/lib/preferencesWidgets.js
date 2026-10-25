import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {validateProfileTypes} from './profileFormat.js';
import {WIDGET_TYPES, parseWidgetLayout, parseLayout} from './widgetLayout.js';

export function addDesktopPreferences(window, settings, _ = text => text, existingPages = []) {
    const watch = (key, callback) => {
        const id = settings.connect(`changed::${key}`, callback);
        window.connect('destroy', () => settings.disconnect(id));
    };
    const toast = text => window.add_toast(new Adw.Toast({title: text}));
    const switchRow = (group, title, key, subtitle = '') => {
        const row = new Adw.SwitchRow({title: _(title), subtitle: _(subtitle)});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    };
    const spin = (group, title, value, min, max, change, step = 1) => {
        const row = new Adw.SpinRow({title: _(title), numeric: true,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10, value})});
        row.connect('notify::value', () => change(Math.round(row.value)));
        group.add(row);
        return row;
    };
    const reset = (group, keys) => {
        const row = new Adw.ActionRow({title: _('Restablecer esta sección')});
        const button = new Gtk.Button({label: _('Restablecer'), valign: Gtk.Align.CENTER});
        button.connect('clicked', () => {
            const old = keys.map(key => [key, settings.get_value(key)]);
            keys.forEach(key => settings.reset(key));
            const undo = new Adw.Toast({title: _('Sección restablecida'), button_label: _('Deshacer')});
            undo.connect('button-clicked', () => old.forEach(([key, value]) => settings.set_value(key, value)));
            window.add_toast(undo);
        });
        row.add_suffix(button);
        group.add(row);
    };
    const order = (page, title, key, labels) => {
        const group = new Adw.PreferencesGroup({title: _(title)});
        page.add(group);
        let rows = [];
        const rebuild = () => {
            rows.forEach(row => group.remove(row));
            rows = [];
            const values = settings.get_strv(key);
            values.forEach((value, index) => {
                const row = new Adw.ActionRow({title: _(labels[value] ?? value)});
                for (const [offset, icon, tip] of [[-1, 'go-up-symbolic', 'Subir'], [1, 'go-down-symbolic', 'Bajar']]) {
                    const button = new Gtk.Button({icon_name: icon, tooltip_text: _(tip), valign: Gtk.Align.CENTER,
                        sensitive: index + offset >= 0 && index + offset < values.length});
                    button.connect('clicked', () => {
                        const next = [...values];
                        [next[index], next[index + offset]] = [next[index + offset], next[index]];
                        settings.set_strv(key, next);
                    });
                    row.add_suffix(button);
                }
                group.add(row);
                rows.push(row);
            });
        };
        rebuild();
        const id = settings.connect(`changed::${key}`, rebuild);
        window.connect('destroy', () => settings.disconnect(id));
        const resetGroup = new Adw.PreferencesGroup();
        page.add(resetGroup);
        reset(resetGroup, [key]);
    };

    const distribution = new Adw.PreferencesPage({title: _('Distribución'), icon_name: 'view-grid-symbolic'});
    window.add(distribution);
    const editing = new Adw.PreferencesGroup({title: _('Editar escritorio'),
        description: _('Super+Shift+W activa la edición. Arrastrá las cabeceras o usá las flechas; Shift+flechas cambia el tamaño. Escape cancela el movimiento.')});
    distribution.add(editing);
    switchRow(editing, 'Modo de edición', 'widgets-edit-mode');
    switchRow(editing, 'Ajustar a cuadrícula', 'widget-snap-to-grid');
    const edges = ['bottom', 'top', 'left', 'right'];
    const dock = new Adw.ComboRow({title: _('Borde del dock'), model: Gtk.StringList.new(['Inferior', 'Superior', 'Izquierdo', 'Derecho'].map(_)),
        selected: Math.max(0, edges.indexOf(settings.get_string('dock-position')))});
    dock.connect('notify::selected', () => settings.set_string('dock-position', edges[dock.selected] ?? 'bottom'));
    editing.add(dock);
    watch('dock-position', () => {
        dock.selected = Math.max(0, edges.indexOf(settings.get_string('dock-position')));
    });
    reset(editing, ['dock-position', 'widget-layout', 'widget-snap-to-grid']);
    order(distribution, 'Orden de módulos de la isla', 'island-module-order',
        {music: 'Música', quick: 'Accesos rápidos', telemetry: 'Hardware', notifications: 'Notificaciones', calendar: 'Calendario'});
    const panel = new Adw.PreferencesPage({title: _('Barra'), icon_name: 'view-more-symbolic'});
    window.add(panel);
    order(panel, 'Grupos del lado izquierdo', 'panel-left-order',
        {activities: 'Actividades', liquidLauncher: 'Aplicaciones', liquidContext: 'Aplicación activa'});
    order(panel, 'Grupos del lado derecho', 'panel-right-order',
        {appindicators: 'Indicadores de aplicaciones', keyboard: 'Idioma del teclado', a11y: 'Accesibilidad', quickSettings: 'Ajustes rápidos'});

    const widgets = new Adw.PreferencesPage({title: _('Widgets'), icon_name: 'application-x-addon-symbolic'});
    window.add(widgets);
    const catalog = new Adw.PreferencesGroup({title: _('Catálogo nativo'),
        description: _('Los widgets se muestran bajo las ventanas. Se ocultan al bloquear la sesión o abrir la vista general. Cada tipo admite una instancia.')});
    widgets.add(catalog);
    const displays = Gdk.Display.get_default()?.get_monitors();
    const monitors = [{id: '', label: _('Monitor principal')}];
    for (let i = 0; displays && i < displays.get_n_items(); i++) {
        const monitor = displays.get_item(i);
        const connector = monitor.get_connector();
        if (connector)
            monitors.push({id: connector, label: connector});
    }
    for (const [type, spec] of Object.entries(WIDGET_TYPES)) {
        const row = new Adw.ExpanderRow({title: _(spec.title)});
        const enabled = new Gtk.Switch({valign: Gtk.Align.CENTER, active: settings.get_strv('widgets-enabled').includes(type),
            tooltip_text: _('Activar widget')});
        enabled.connect('notify::active', () => {
            const values = settings.get_strv('widgets-enabled').filter(value => value !== type);
            if (enabled.active)
                values.push(type);
            settings.set_strv('widgets-enabled', values);
        });
        const enabledId = settings.connect('changed::widgets-enabled', () => {
            enabled.active = settings.get_strv('widgets-enabled').includes(type);
        });
        window.connect('destroy', () => settings.disconnect(enabledId));
        row.add_suffix(enabled);
        catalog.add(row);
        const defaults = {monitor: '', x: 24, y: 60, width: spec.width, height: spec.height};
        const saved = parseWidgetLayout(settings.get_string('widget-layout')).widgets[type] ?? defaults;
        let syncing = false;
        const update = (key, value) => {
            if (syncing)
                return;
            const layout = parseWidgetLayout(settings.get_string('widget-layout'));
            layout.widgets[type] = {...defaults, ...layout.widgets[type], [key]: value};
            settings.set_string('widget-layout', JSON.stringify(layout));
        };
        const placement = new Adw.ComboRow({title: _('Monitor'), model: Gtk.StringList.new(monitors.map(m => m.label)),
            selected: Math.max(0, monitors.findIndex(m => m.id === saved.monitor))});
        placement.connect('notify::selected', () => update('monitor', monitors[placement.selected]?.id ?? ''));
        row.add_row(placement);
        const proxy = {add: child => row.add_row(child)};
        const controls = {};
        for (const [key, title, min, max] of [['x', 'Posición horizontal', 0, 16000], ['y', 'Posición vertical', 0, 16000],
            ['width', 'Ancho', spec.minWidth, 4000], ['height', 'Alto', spec.minHeight, 4000]])
            controls[key] = spin(proxy, title, saved[key], min, max, value => update(key, value));
        const layoutId = settings.connect('changed::widget-layout', () => {
            const current = parseWidgetLayout(settings.get_string('widget-layout')).widgets[type] ?? defaults;
            syncing = true;
            try {
                placement.selected = Math.max(0, monitors.findIndex(m => m.id === current.monitor));
                for (const [key, control] of Object.entries(controls)) {
                    if (control.value !== current[key])
                        control.value = current[key];
                }
            } finally {
                syncing = false;
            }
        });
        window.connect('destroy', () => settings.disconnect(layoutId));
    }
    const local = new Adw.PreferencesGroup({title: _('Datos locales')});
    widgets.add(local);
    local.add(new Adw.ActionRow({title: _('Nota')}));
    const note = new Gtk.TextView({wrap_mode: Gtk.WrapMode.WORD_CHAR, accepts_tab: false,
        top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
        tooltip_text: _('Nota local de varias líneas')});
    const noteScroll = new Gtk.ScrolledWindow({min_content_height: 120, max_content_height: 240,
        child: note, propagate_natural_height: true});
    settings.bind('widget-notes', note.buffer, 'text', Gio.SettingsBindFlags.DEFAULT);
    local.add(noteScroll);
    const duration = spin(local, 'Duración del temporizador (segundos)', settings.get_int('widget-timer-seconds'), 1, 86400,
        value => settings.set_int('widget-timer-seconds', value));
    watch('widget-timer-seconds', () => { duration.value = settings.get_int('widget-timer-seconds'); });
    reset(local, ['widgets-enabled', 'widget-timer-seconds']);

    const integrations = new Adw.PreferencesPage({title: _('Integraciones'), icon_name: 'network-workgroup-symbolic'});
    window.add(integrations);
    const music = new Adw.PreferencesGroup({title: _('Música'),
        description: _('MPRIS conecta las aplicaciones compatibles. Pausar o detener una canción conserva el widget; salir de la aplicación lo oculta.')});
    integrations.add(music);
    switchRow(music, 'Mostrar música en la isla', 'music-show-island');
    switchRow(music, 'Mostrar tarjeta musical', 'music-show-widget', 'También debe estar activado el widget Música en el catálogo.');
    const native = new Adw.PreferencesGroup({title: _('Servicios nativos')});
    integrations.add(native);
    for (const [title, subtitle] of [
        ['Spotify y Brave', 'Controles mediante MPRIS; las acciones disponibles dependen de cada aplicación.'],
        ['Calendario', 'Eventos mediante el servicio de calendario de GNOME y las cuentas configuradas en el sistema.'],
        ['Clima', 'Ubicación guardada en GNOME Weather. Configurala desde la aplicación Clima.'],
        ['Discord', 'Acceso rápido disponible. Estado de voz y micrófono requieren una interfaz verificada; no se simulan.'],
    ])
        native.add(new Adw.ActionRow({title: _(title), subtitle: _(subtitle)}));
    reset(music, ['music-show-island', 'music-show-widget']);
    const messaging = new Adw.PreferencesGroup({title: _('Mensajería'), description: _('Las burbujas usan las notificaciones nativas y respetan No molestar y la política de cada aplicación.')});
    integrations.add(messaging);
    switchRow(messaging, 'Burbujas de cristal', 'messaging-bubbles');
    reset(messaging, ['messaging-bubbles', 'messaging-apps']);

    const profiles = new Adw.PreferencesGroup({title: _('Guardar distribución y preferencias')});
    distribution.add(profiles);
    const excluded = key => key.startsWith('legacy-') || ['manage-legacy-widget', 'widgets-edit-mode'].includes(key);
    const keys = settings.settings_schema.list_keys().filter(key => !excluded(key));
    const descriptors = Object.fromEntries(keys.map(key => [key, {type: settings.settings_schema.get_key(key).get_value_type().dup_string()}]));
    for (const [label, save] of [['Exportar ajustes…', true], ['Importar ajustes…', false]]) {
        const row = new Adw.ActionRow({title: _(label), activatable: true});
        profiles.add(row);
        row.connect('activated', () => {
            const dialog = new Gtk.FileDialog({title: _(label), initial_name: save ? 'liquid-glass.json' : null});
            if (save) {
                dialog.save(window, null, (source, result) => {
                    try {
                        const file = source.save_finish(result);
                        const profile = {format: 'liquid-glass', version: 1,
                            settings: Object.fromEntries(keys.map(key => [key, settings.get_value(key).deep_unpack()]))};
                        const bytes = new TextEncoder().encode(JSON.stringify(profile, null, 2));
                        file.replace_contents_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                            try { f.replace_contents_finish(res); toast(_('Ajustes exportados')); }
                            catch (error) { toast(error.message); }
                        });
                    } catch (error) {
                        if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) toast(error.message);
                    }
                });
            } else {
                dialog.open(window, null, (source, result) => {
                    try {
                        const file = source.open_finish(result);
                        file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                            GLib.PRIORITY_DEFAULT, null, (infoFile, infoResult) => {
                            try {
                                const info = infoFile.query_info_finish(infoResult);
                                if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 2 * 1024 * 1024)
                                    throw new Error(_('Elegí un archivo de ajustes regular de hasta 2 MiB'));
                            } catch (error) { toast(error.message); return; }
                            file.load_contents_async(null, (f, res) => {
                            try {
                                const [, bytes] = f.load_contents_finish(res);
                                if (bytes.length > 2 * 1024 * 1024) throw new Error(_('Archivo demasiado grande'));
                                const profile = JSON.parse(new TextDecoder().decode(bytes));
                                const entries = validateProfileTypes(profile, descriptors).map(([key, value]) => {
                                    const schemaKey = settings.settings_schema.get_key(key);
                                    const variant = new GLib.Variant(schemaKey.get_value_type().dup_string(), value);
                                    if (!schemaKey.range_check(variant)) throw new Error(`${_('Valor fuera de rango')}: ${key}`);
                                    if (key === 'widget-layout') parseLayout(value);
                                    return [key, variant];
                                });
                                const transaction = new Gio.Settings({settings_schema: settings.settings_schema});
                                transaction.delay();
                                entries.forEach(([key, value]) => transaction.set_value(key, value));
                                transaction.apply();
                                toast(_('Ajustes importados'));
                            } catch (error) { toast(error.message); }
                            });
                        });
                    } catch (error) {
                        if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) toast(error.message);
                    }
                });
            }
        });
    }

    // Existing pages gain section resets without replacing their saved settings.
    const sections = [
        ['Isla Dinámica', ['island-position', 'island-width', 'pill-scale', 'island-offset-y', 'enable-animations', 'animation-speed']],
        ['Dock y Mis Apps', ['dock-intellihide', 'dock-magnification', 'dock-icon-size', 'dock-max-apps', 'dock-show-running', 'dock-show-apps-button']],
        ['Calendario y Reloj', ['clock-use-24h', 'clock-show-seconds', 'clock-show-date', 'calendar-week-start']],
        ['Estética y Colores', ['appearance', 'blur-strength', 'glass-opacity', 'corner-radius', 'dynamic-album-accent', 'custom-accent-color']],
        ['Módulos y Hardware', ['show-telemetry-pill', 'show-telemetry-panel', 'show-quick-controls']],
    ];
    for (const [title, sectionKeys] of sections) {
        const valid = sectionKeys.filter(key => settings.settings_schema.has_key(key));
        for (const page of existingPages) {
            if (page.title === title) {
                const group = new Adw.PreferencesGroup();
                reset(group, valid);
                page.add(group);
            }
        }
    }
    return {integrations, widgets, distribution, panel};
}
