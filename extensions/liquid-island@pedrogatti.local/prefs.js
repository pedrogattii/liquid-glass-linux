import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {addDesktopPreferences} from './lib/preferencesWidgets.js';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Injects custom CSS rules for color preset swatch buttons and list action spacing.
 *
 * @param {Adw.PreferencesWindow} window
 */
function applyCustomStyles(window) {
    const css = `
        .swatch-btn {
            min-width: 32px;
            min-height: 32px;
            border-radius: 9999px;
            padding: 0;
            border: 2px solid rgba(255, 255, 255, 0.35);
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
            transition: transform 150ms cubic-bezier(0.2, 0, 0, 1), box-shadow 150ms ease;
        }
        .swatch-btn:hover {
            transform: scale(1.15);
            box-shadow: 0 3px 8px rgba(0, 0, 0, 0.35);
        }
        .swatch-btn:active {
            transform: scale(0.92);
        }
        .swatch-cyan { background-color: #5ac8fa; }
        .swatch-apple-blue { background-color: #0a84ff; }
        .swatch-spotify-green { background-color: #1ed760; }
        .swatch-purple { background-color: #bf5af2; }
        .swatch-sunset { background-color: #ff9f0a; }
        .swatch-rose { background-color: #ff375f; }
        .app-action-box {
            margin-top: 2px;
            margin-bottom: 2px;
        }
    `;

    const provider = new Gtk.CssProvider();
    if (provider.load_from_string) {
        provider.load_from_string(css);
    } else {
        provider.load_from_data(css);
    }

    const display = window.get_display?.() || Gtk.Widget.prototype.get_display.call(window);
    if (display) {
        Gtk.StyleContext.add_provider_for_display(
            display,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }
}

/**
 * Returns installed desktop applications that should be displayed.
 *
 * @returns {Gio.AppInfo[]}
 */
function getInstalledDesktopApps() {
    return Gio.AppInfo.get_all()
        .filter(app => {
            try {
                return app.should_show() && !!app.get_id();
            } catch {
                return false;
            }
        })
        .sort((a, b) => {
            const nameA = a.get_display_name() || a.get_id() || '';
            const nameB = b.get_display_name() || b.get_id() || '';
            return nameA.localeCompare(nameB, undefined, {sensitivity: 'base'});
        });
}

/**
 * Creates an interactive application list manager group.
 * Allows adding, removing, and reordering applications stored in a GSettings string array ('as').
 *
 * @param {object} params
 * @param {Gio.Settings} params.settings
 * @param {string} params.key
 * @param {string} params.title
 * @param {string} params.description
 * @param {string} params.addTitle
 * @param {string} params.addSubtitle
 * @param {string} params.addBtnLabel
 * @param {Adw.PreferencesWindow} [params.window]
 * @returns {Adw.PreferencesGroup}
 */
function createAppListManager({
    settings,
    key,
    title,
    description,
    addTitle,
    addSubtitle,
    addBtnLabel,
    window,
}) {
    const group = new Adw.PreferencesGroup({
        title,
        description,
    });

    const installedApps = getInstalledDesktopApps();
    const appLabels = installedApps.map(app => {
        const name = app.get_display_name() || app.get_id();
        const id = app.get_id();
        return name !== id ? `${name} (${id})` : name;
    });

    const addRow = new Adw.ComboRow({
        title: addTitle,
        subtitle: addSubtitle,
        model: Gtk.StringList.new(appLabels),
    });
    if ('enable_search' in addRow) {
        addRow.enable_search = true;
    }

    const addBtn = new Gtk.Button({
        label: addBtnLabel,
        icon_name: 'list-add-symbolic',
        valign: Gtk.Align.CENTER,
    });
    addBtn.add_css_class('suggested-action');

    addBtn.connect('clicked', () => {
        const selectedIdx = addRow.selected;
        if (selectedIdx >= 0 && selectedIdx < installedApps.length) {
            const selectedApp = installedApps[selectedIdx];
            const appId = selectedApp.get_id();
            const currentList = settings.get_strv(key);
            if (!currentList.includes(appId)) {
                settings.set_strv(key, [...currentList, appId]);
                rebuildRows();
                if (window?.add_toast) {
                    window.add_toast(new Adw.Toast({
                        title: `"${selectedApp.get_display_name()}" agregada.`,
                    }));
                }
            } else if (window?.add_toast) {
                window.add_toast(new Adw.Toast({
                    title: `"${selectedApp.get_display_name()}" ya está en la lista.`,
                }));
            }
        }
    });

    addRow.add_suffix(addBtn);
    group.add(addRow);

    let itemRows = [];
    let isRebuilding = false;

    function rebuildRows() {
        if (isRebuilding) return;
        isRebuilding = true;

        try {
            for (const row of itemRows) {
                group.remove(row);
            }
            itemRows = [];

            const currentApps = settings.get_strv(key);

            if (currentApps.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: 'No hay aplicaciones fijadas',
                    subtitle: 'Usá el selector superior para agregar aplicaciones a la lista.',
                });
                emptyRow.add_css_class('dim-label');
                group.add(emptyRow);
                itemRows.push(emptyRow);
                return;
            }

            currentApps.forEach((appId, index) => {
                let appInfo = null;
                try {
                    appInfo = GioUnix.DesktopAppInfo.new(appId);
                } catch {
                    // Fallback to installed list
                }
                if (!appInfo) {
                    appInfo = installedApps.find(a => a.get_id() === appId) || null;
                }

                const displayName = appInfo ? appInfo.get_display_name() : appId;
                const row = new Adw.ActionRow({
                    title: displayName,
                    subtitle: appId,
                });

                const icon = appInfo ? appInfo.get_icon() : null;
                let iconWidget;
                if (icon) {
                    iconWidget = new Gtk.Image({
                        gicon: icon,
                        pixel_size: 28,
                        valign: Gtk.Align.CENTER,
                    });
                } else {
                    iconWidget = new Gtk.Image({
                        icon_name: 'application-x-executable',
                        pixel_size: 28,
                        valign: Gtk.Align.CENTER,
                    });
                }
                row.add_prefix(iconWidget);

                const btnBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 4,
                    valign: Gtk.Align.CENTER,
                });
                btnBox.add_css_class('app-action-box');

                // Move Up button
                const upBtn = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Subir posición',
                    sensitive: index > 0,
                });
                upBtn.add_css_class('flat');
                upBtn.connect('clicked', () => {
                    const list = [...settings.get_strv(key)];
                    if (index > 0) {
                        const temp = list[index];
                        list[index] = list[index - 1];
                        list[index - 1] = temp;
                        settings.set_strv(key, list);
                        rebuildRows();
                    }
                });
                btnBox.append(upBtn);

                // Move Down button
                const downBtn = new Gtk.Button({
                    icon_name: 'go-down-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Bajar posición',
                    sensitive: index < currentApps.length - 1,
                });
                downBtn.add_css_class('flat');
                downBtn.connect('clicked', () => {
                    const list = [...settings.get_strv(key)];
                    if (index < list.length - 1) {
                        const temp = list[index];
                        list[index] = list[index + 1];
                        list[index + 1] = temp;
                        settings.set_strv(key, list);
                        rebuildRows();
                    }
                });
                btnBox.append(downBtn);

                // Delete button
                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Quitar de la lista',
                });
                delBtn.add_css_class('flat');
                delBtn.add_css_class('destructive-action');
                delBtn.connect('clicked', () => {
                    const list = settings.get_strv(key).filter((_, i) => i !== index);
                    settings.set_strv(key, list);
                    rebuildRows();
                });
                btnBox.append(delBtn);

                row.add_suffix(btnBox);
                group.add(row);
                itemRows.push(row);
            });
        } finally {
            isRebuilding = false;
        }
    }

    const changedId = settings.connect(`changed::${key}`, () => {
        rebuildRows();
    });

    if (window) {
        window.connect('destroy', () => {
            try {
                settings.disconnect(changedId);
            } catch {
                // Ignore if already disconnected
            }
        });
    }

    rebuildRows();
    return group;
}

export default class LiquidIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(780, 680);
        applyCustomStyles(window);

        // ==========================================
        // PAGE 1: Isla Dinámica
        // ==========================================
        const pageIsland = new Adw.PreferencesPage({
            title: 'Isla Dinámica',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(pageIsland);

        // Group: Posición y Dimensiones
        const groupDimensions = new Adw.PreferencesGroup({
            title: 'Posición y Dimensiones',
            description: 'Alineación, ancho del panel desplegado y escala de la cápsula',
        });
        pageIsland.add(groupDimensions);

        // island-position
        const positionOptions = [
            { id: 'center', label: 'Centro' },
            { id: 'left', label: 'Izquierda' },
            { id: 'right', label: 'Derecha' },
        ];
        const currentPos = settings.get_string('island-position');
        const posRow = new Adw.ComboRow({
            title: 'Posición de la isla',
            subtitle: 'Alineación horizontal en la barra superior',
            model: Gtk.StringList.new(positionOptions.map(p => p.label)),
            selected: Math.max(0, positionOptions.findIndex(p => p.id === currentPos)),
        });
        posRow.connect('notify::selected', () => {
            const sel = posRow.selected;
            if (sel >= 0 && sel < positionOptions.length) {
                settings.set_string('island-position', positionOptions[sel].id);
            }
        });
        groupDimensions.add(posRow);

        // island-width: 360 to 580, step 10
        const widthRow = new Adw.SpinRow({
            title: 'Ancho del panel desplegado (px)',
            subtitle: 'Ancho máximo de la tarjeta extendida de la isla',
            adjustment: new Gtk.Adjustment({
                lower: 360,
                upper: 580,
                step_increment: 10,
                page_increment: 20,
                value: settings.get_int('island-width'),
            }),
        });
        settings.bind('island-width', widthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupDimensions.add(widthRow);

        // pill-scale: 0.85 to 1.30, step 0.05, digits 2
        const pillScaleRow = new Adw.SpinRow({
            title: 'Escala de la píldora superior',
            subtitle: 'Proporción de escala de la cápsula en reposo en la barra',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.85,
                upper: 1.30,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('pill-scale'),
            }),
        });
        settings.bind('pill-scale', pillScaleRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupDimensions.add(pillScaleRow);

        // island-offset-y: 0 to 28, step 1
        const offsetYRow = new Adw.SpinRow({
            title: 'Separación vertical superior (px)',
            subtitle: 'Margen desde el borde superior de la pantalla',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 28,
                step_increment: 1,
                page_increment: 2,
                value: settings.get_int('island-offset-y'),
            }),
        });
        settings.bind('island-offset-y', offsetYRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupDimensions.add(offsetYRow);

        // Group: Comportamiento y Animaciones
        const groupBehavior = new Adw.PreferencesGroup({
            title: 'Comportamiento y Animaciones',
            description: 'Física elástica, velocidad de transición y atajos globales',
        });
        pageIsland.add(groupBehavior);

        // enable-animations
        const enableAnimRow = new Adw.SwitchRow({
            title: 'Física de resortes (Spring Animations)',
            subtitle: 'Animaciones fluidas y dinámicas con rebote físico elástico',
        });
        settings.bind('enable-animations', enableAnimRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupBehavior.add(enableAnimRow);

        // animation-speed: 0.5 to 2.0, step 0.1, digits 1
        const animSpeedRow = new Adw.SpinRow({
            title: 'Velocidad de animación',
            subtitle: 'Multiplicador de duración de apertura y transformaciones (1.0 = estándar)',
            digits: 1,
            adjustment: new Gtk.Adjustment({
                lower: 0.5,
                upper: 2.0,
                step_increment: 0.1,
                page_increment: 0.2,
                value: settings.get_double('animation-speed'),
            }),
        });
        settings.bind('animation-speed', animSpeedRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupBehavior.add(animSpeedRow);

        // show-banners
        const showBannersRow = new Adw.SwitchRow({
            title: 'Mostrar banners emergentes de notificaciones',
            subtitle: 'Expande la isla automáticamente para desplegar avisos entrantes',
        });
        settings.bind('show-banners', showBannersRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupBehavior.add(showBannersRow);

        // toggle-island
        const toggleIslandRow = new Adw.EntryRow({
            title: 'Atajo global para abrir/cerrar la isla',
            text: settings.get_strv('toggle-island')[0] ?? '',
            show_apply_button: true,
        });
        toggleIslandRow.connect('apply', () => {
            const value = toggleIslandRow.text.trim();
            const [valid, key, modifiers] = Gtk.accelerator_parse(value);
            if (value === '' || (valid && Gtk.accelerator_valid(key, modifiers))) {
                settings.set_strv('toggle-island', value ? [value] : []);
                toggleIslandRow.remove_css_class('error');
                if (window?.add_toast) {
                    window.add_toast(new Adw.Toast({
                        title: value ? `Atajo guardado: ${value}` : 'Atajo desactivado',
                    }));
                }
            } else {
                toggleIslandRow.add_css_class('error');
                if (window?.add_toast) {
                    window.add_toast(new Adw.Toast({
                        title: 'Atajo inválido. Formato esperado: <Super>i o <Control><Alt>i',
                    }));
                }
            }
        });
        groupBehavior.add(toggleIslandRow);

        const shortcutHintRow = new Adw.ActionRow({
            title: 'Formato del atajo',
            subtitle: 'Ejemplo: &lt;Super&gt;i. Dejá el campo vacío para desactivarlo. Presioná el botón de aplicar.',
        });
        groupBehavior.add(shortcutHintRow);

        // ==========================================
        // PAGE 2: Dock y Mis Apps
        // ==========================================
        const pageDock = new Adw.PreferencesPage({
            title: 'Dock y Mis Apps',
            icon_name: 'view-app-grid-symbolic',
        });
        window.add(pageDock);

        // Group: Configuración del Dock Liquid Glass
        const groupDockConfig = new Adw.PreferencesGroup({
            title: 'Configuración del Dock Liquid Glass',
            description: 'Parámetros del dock translúcido y barra modular inferior',
        });
        pageDock.add(groupDockConfig);

        // desktop-style
        const desktopStyleRow = new Adw.SwitchRow({
            title: 'Activar Dock y Barra Superior Liquid Glass',
            subtitle: 'Aplica el diseño de cápsulas de cristal y activa el dock flotante',
        });
        settings.bind('desktop-style', desktopStyleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupDockConfig.add(desktopStyleRow);

        // dock-intellihide
        const intellihideRow = new Adw.SwitchRow({
            title: 'Intellihide (Mostrar al acercar el mouse al borde inferior)',
            subtitle: 'Oculta el dock cuando hay ventanas superpuestas y lo revela en el borde',
        });
        settings.bind('dock-intellihide', intellihideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupDockConfig.add(intellihideRow);

        // dock-magnification
        const magnificationRow = new Adw.SwitchRow({
            title: 'Efecto Lupa estilo macOS al pasar el cursor',
            subtitle: 'Efecto zoom dinámico y fluido sobre los iconos al mover el ratón',
        });
        settings.bind('dock-magnification', magnificationRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupDockConfig.add(magnificationRow);

        // dock-icon-size: 32 to 64, step 2
        const iconSizeRow = new Adw.SpinRow({
            title: 'Tamaño de iconos del Dock (px)',
            subtitle: 'Tamaño base en píxeles de los iconos en reposo',
            adjustment: new Gtk.Adjustment({
                lower: 32,
                upper: 64,
                step_increment: 2,
                page_increment: 4,
                value: settings.get_int('dock-icon-size'),
            }),
        });
        settings.bind('dock-icon-size', iconSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupDockConfig.add(iconSizeRow);

        // dock-max-apps: 6 to 28, step 1
        const maxAppsRow = new Adw.SpinRow({
            title: 'Capacidad máxima de aplicaciones',
            subtitle: 'Cantidad tope de accesos visibles antes de compactar el dock',
            adjustment: new Gtk.Adjustment({
                lower: 6,
                upper: 28,
                step_increment: 1,
                page_increment: 2,
                value: settings.get_int('dock-max-apps'),
            }),
        });
        settings.bind('dock-max-apps', maxAppsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupDockConfig.add(maxAppsRow);

        // dock-show-running
        const showRunningRow = new Adw.SwitchRow({
            title: 'Mostrar aplicaciones abiertas no fijadas',
            subtitle: 'Añade ventanas en ejecución activas con punto indicador de estado',
        });
        settings.bind('dock-show-running', showRunningRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupDockConfig.add(showRunningRow);

        // dock-show-apps-button
        const showAppsBtnRow = new Adw.SwitchRow({
            title: 'Mostrar botón de Cajón de Aplicaciones',
            subtitle: 'Botón rápido para abrir la cuadrícula de todas las aplicaciones instaladas',
        });
        settings.bind('dock-show-apps-button', showAppsBtnRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupDockConfig.add(showAppsBtnRow);

        // Group: Ordenar y Gestionar Apps del Dock (org.gnome.shell favorite-apps)
        const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        const dockAppsManagerGroup = createAppListManager({
            settings: shellSettings,
            key: 'favorite-apps',
            title: 'Ordenar y Gestionar Apps del Dock',
            description: 'Administrá el orden y las aplicaciones fijadas en el dock de GNOME y Liquid Glass',
            addTitle: 'Agregar aplicación al Dock',
            addSubtitle: 'Seleccioná una aplicación instalada en el sistema',
            addBtnLabel: 'Agregar al Dock',
            window,
        });
        pageDock.add(dockAppsManagerGroup);

        // ==========================================
        // PAGE 3: Calendario y Reloj
        // ==========================================
        const pageCalendar = new Adw.PreferencesPage({
            title: 'Calendario y Reloj',
            icon_name: 'x-office-calendar-symbolic',
        });
        window.add(pageCalendar);

        // Group: Formato de Reloj
        const groupClock = new Adw.PreferencesGroup({
            title: 'Formato de Reloj',
            description: 'Opciones de visualización horaria en la píldora superior',
        });
        pageCalendar.add(groupClock);

        // clock-use-24h
        const use24hRow = new Adw.SwitchRow({
            title: 'Formato de 24 horas',
            subtitle: 'Visualización en formato 24 horas (ej. 14:30) en lugar de AM/PM',
        });
        settings.bind('clock-use-24h', use24hRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupClock.add(use24hRow);

        // clock-show-seconds
        const showSecondsRow = new Adw.SwitchRow({
            title: 'Mostrar segundos en la píldora',
            subtitle: 'Actualiza y muestra el segundero activo en el reloj de la barra',
        });
        settings.bind('clock-show-seconds', showSecondsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupClock.add(showSecondsRow);

        // clock-show-date
        const showDateRow = new Adw.SwitchRow({
            title: 'Mostrar fecha corta junto a la hora',
            subtitle: 'Muestra el día de la semana y fecha abreviada junto a la hora',
        });
        settings.bind('clock-show-date', showDateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupClock.add(showDateRow);

        // Group: Calendario Liquid Glass
        const groupCalendarConfig = new Adw.PreferencesGroup({
            title: 'Calendario Liquid Glass',
            description: 'Comportamiento y convención semanal del calendario integrado',
        });
        pageCalendar.add(groupCalendarConfig);

        // calendar-week-start: Lunes (1), Domingo (0)
        const weekStartOptions = [
            { value: 1, label: 'Lunes' },
            { value: 0, label: 'Domingo' },
        ];
        const currentWeekStart = settings.get_int('calendar-week-start');
        const weekSelectedIndex = Math.max(0, weekStartOptions.findIndex(o => o.value === currentWeekStart));
        const weekStartRow = new Adw.ComboRow({
            title: 'Primer día de la semana',
            subtitle: 'Día que encabeza las columnas de días en el calendario',
            model: Gtk.StringList.new(weekStartOptions.map(o => o.label)),
            selected: weekSelectedIndex,
        });
        weekStartRow.connect('notify::selected', () => {
            const sel = weekStartRow.selected;
            if (sel >= 0 && sel < weekStartOptions.length) {
                settings.set_int('calendar-week-start', weekStartOptions[sel].value);
            }
        });
        groupCalendarConfig.add(weekStartRow);

        // ==========================================
        // PAGE 4: Estética y Colores
        // ==========================================
        const pageAesthetics = new Adw.PreferencesPage({
            title: 'Estética y Colores',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(pageAesthetics);

        // Group: Material Liquid Glass
        const groupMaterial = new Adw.PreferencesGroup({
            title: 'Material Liquid Glass',
            description: 'Desenfoque GPU Dual-Kawase, opacidad y redondeo de esquinas',
        });
        pageAesthetics.add(groupMaterial);

        // appearance: auto, light, dark
        const appearances = [
            { id: 'auto', label: 'Automático (Sigue el tema del sistema)' },
            { id: 'light', label: 'Claro (Cristal luminoso)' },
            { id: 'dark', label: 'Oscuro (Cristal profundo ahumado)' },
        ];
        const currentAppearance = settings.get_string('appearance');
        const appearanceIndex = Math.max(0, appearances.findIndex(a => a.id === currentAppearance));
        const appearanceRow = new Adw.ComboRow({
            title: 'Apariencia del cristal',
            subtitle: 'Adaptación tonal del material translúcido',
            model: Gtk.StringList.new(appearances.map(a => a.label)),
            selected: appearanceIndex,
        });
        appearanceRow.connect('notify::selected', () => {
            const sel = appearanceRow.selected;
            if (sel >= 0 && sel < appearances.length) {
                settings.set_string('appearance', appearances[sel].id);
            }
        });
        groupMaterial.add(appearanceRow);

        // blur-strength: 0.0 to 1.0, step 0.05, digits 2
        const blurStrengthRow = new Adw.SpinRow({
            title: 'Intensidad del desenfoque GPU',
            subtitle: 'Fuerza de difusión y desenfoque del fondo de pantalla (0.0 a 1.0)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 1.0,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('blur-strength'),
            }),
        });
        settings.bind('blur-strength', blurStrengthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupMaterial.add(blurStrengthRow);

        // glass-opacity: 0.15 to 0.90, step 0.05, digits 2
        const glassOpacityRow = new Adw.SpinRow({
            title: 'Opacidad del cristal',
            subtitle: 'Densidad translúcida de las superficies de cristal (0.15 a 0.90)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.15,
                upper: 0.90,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('glass-opacity'),
            }),
        });
        settings.bind('glass-opacity', glassOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupMaterial.add(glassOpacityRow);

        // corner-radius: 14 to 40, step 2
        const cornerRadiusRow = new Adw.SpinRow({
            title: 'Radio de redondeo de bordes (px)',
            subtitle: 'Curvatura en las esquinas de la isla y superficies flotantes',
            adjustment: new Gtk.Adjustment({
                lower: 14,
                upper: 40,
                step_increment: 2,
                page_increment: 4,
                value: settings.get_int('corner-radius'),
            }),
        });
        settings.bind('corner-radius', cornerRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupMaterial.add(cornerRadiusRow);

        // Group: Color de Acento
        const groupAccent = new Adw.PreferencesGroup({
            title: 'Color de Acento',
            description: 'Paleta dinámica de reproducción musical y acentos personalizados',
        });
        pageAesthetics.add(groupAccent);

        // dynamic-album-accent
        const dynamicAlbumRow = new Adw.SwitchRow({
            title: 'Color de acento dinámico según la carátula de la canción',
            subtitle: 'Extrae automáticamente el tono predominante del reproductor MPRIS activo',
        });
        settings.bind('dynamic-album-accent', dynamicAlbumRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupAccent.add(dynamicAlbumRow);

        // custom-accent-color: EntryRow + presets
        const accentColorRow = new Adw.EntryRow({
            title: 'Color de acento personalizado (HEX)',
            text: settings.get_string('custom-accent-color'),
            show_apply_button: true,
        });
        accentColorRow.connect('apply', () => {
            let value = accentColorRow.text.trim();
            if (!value.startsWith('#')) {
                value = `#${value}`;
            }
            const isValid = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
            if (isValid) {
                settings.set_string('custom-accent-color', value);
                accentColorRow.remove_css_class('error');
                if (window?.add_toast) {
                    window.add_toast(new Adw.Toast({
                        title: `Color de acento guardado: ${value}`,
                    }));
                }
            } else {
                accentColorRow.add_css_class('error');
                if (window?.add_toast) {
                    window.add_toast(new Adw.Toast({
                        title: 'Código hexadecimal inválido. Ejemplo: #5ac8fa',
                    }));
                }
            }
        });
        groupAccent.add(accentColorRow);

        // Preset Color Buttons
        const presetRow = new Adw.ActionRow({
            title: 'Paletas y Colores Predefinidos',
            subtitle: 'Hacé clic en una muestra para aplicar el color de acento al instante',
        });

        const swatchesBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });

        const presets = [
            { name: 'Cyan', hex: '#5ac8fa', cssClass: 'swatch-cyan' },
            { name: 'Apple Blue', hex: '#0a84ff', cssClass: 'swatch-apple-blue' },
            { name: 'Spotify Green', hex: '#1ed760', cssClass: 'swatch-spotify-green' },
            { name: 'Purple', hex: '#bf5af2', cssClass: 'swatch-purple' },
            { name: 'Sunset', hex: '#ff9f0a', cssClass: 'swatch-sunset' },
            { name: 'Rose', hex: '#ff375f', cssClass: 'swatch-rose' },
        ];

        for (const preset of presets) {
            const btn = new Gtk.Button({
                tooltip_text: `${preset.name} (${preset.hex})`,
                valign: Gtk.Align.CENTER,
            });
            btn.add_css_class('circular');
            btn.add_css_class('swatch-btn');
            btn.add_css_class(preset.cssClass);

            btn.connect('clicked', () => {
                settings.set_string('custom-accent-color', preset.hex);
                accentColorRow.text = preset.hex;
                accentColorRow.remove_css_class('error');
                if (window?.add_toast) {
                    window.add_toast(new Adw.Toast({
                        title: `Color aplicado: ${preset.name} (${preset.hex})`,
                    }));
                }
            });

            swatchesBox.append(btn);
        }
        presetRow.add_suffix(swatchesBox);
        groupAccent.add(presetRow);

        const accentChangedId = settings.connect('changed::custom-accent-color', () => {
            accentColorRow.text = settings.get_string('custom-accent-color');
        });
        window.connect('destroy', () => {
            try {
                settings.disconnect(accentChangedId);
            } catch {
                // Ignore
            }
        });

        // ==========================================
        // PAGE 5: Módulos y Hardware
        // ==========================================
        const pageHardware = new Adw.PreferencesPage({
            title: 'Módulos y Hardware',
            icon_name: 'utilities-system-monitor-symbolic',
        });
        window.add(pageHardware);

        // Group: Telemetría del Sistema en Vivo
        const groupTelemetry = new Adw.PreferencesGroup({
            title: 'Telemetría del Sistema en Vivo',
            description: 'Monitoreo de CPU, memoria RAM y sensores térmicos',
        });
        pageHardware.add(groupTelemetry);

        // show-telemetry-pill
        const showPillTelemetryRow = new Adw.SwitchRow({
            title: 'Mostrar chip de CPU/RAM en la píldora superior',
            subtitle: 'Indicadores en tiempo real en la barra superior en modo cerrado',
        });
        settings.bind('show-telemetry-pill', showPillTelemetryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupTelemetry.add(showPillTelemetryRow);

        // show-telemetry-panel
        const showPanelTelemetryRow = new Adw.SwitchRow({
            title: 'Mostrar tarjeta de CPU, RAM y Temperatura al abrir la Isla',
            subtitle: 'Gráficos detallados y barras de hardware en el panel extendido de la isla',
        });
        settings.bind('show-telemetry-panel', showPanelTelemetryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupTelemetry.add(showPanelTelemetryRow);

        // Group: Centro de Control y Lanzador Rápido en la Isla
        const groupQuickControls = new Adw.PreferencesGroup({
            title: 'Centro de Control y Lanzador Rápido en la Isla',
            description: 'Panel de utilidades y fila de aplicaciones rápidas en el menú desplegable',
        });
        pageHardware.add(groupQuickControls);

        // show-quick-controls
        const showQuickControlsRow = new Adw.SwitchRow({
            title: 'Mostrar botones de Control Rápido y Lanzador de Apps en la Isla',
            subtitle: 'Habilita los controles del sistema y la cuadrícula de accesos directos',
        });
        settings.bind('show-quick-controls', showQuickControlsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupQuickControls.add(showQuickControlsRow);

        // Interactive manager for pinned-island-apps
        const islandAppsManagerGroup = createAppListManager({
            settings,
            key: 'pinned-island-apps',
            title: 'Aplicaciones Fijadas en la Isla',
            description: 'Reordená, agregá o quitá aplicaciones del lanzador rápido de la Dynamic Island',
            addTitle: 'Agregar aplicación a la Isla',
            addSubtitle: 'Seleccioná una aplicación instalada en el sistema',
            addBtnLabel: 'Agregar a la Isla',
            window,
        });
        pageHardware.add(islandAppsManagerGroup);
        const advanced = addDesktopPreferences(window, settings, text => this.gettext(text),
            [pageIsland, pageDock, pageCalendar, pageAesthetics, pageHardware]);
        advanced.integrations.add(createAppListManager({settings, key: 'messaging-apps',
            title: 'Aplicaciones con Burbujas', description: 'Notificaciones de estas aplicaciones con estilo de cristal',
            addTitle: 'Agregar aplicación de mensajería', addSubtitle: 'Seleccioná una aplicación instalada',
            addBtnLabel: 'Agregar', window}));
    }
}
