import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LiquidIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Liquid Island', icon_name: 'preferences-desktop-appearance-symbolic'});
        window.add(page);
        const material = new Adw.PreferencesGroup({title: 'Material', description: 'Cristal y contraste adaptados al escritorio.'});
        page.add(material);

        const appearances = ['auto', 'light', 'dark'];
        const appearance = new Adw.ComboRow({
            title: 'Apariencia',
            model: Gtk.StringList.new(['Automática', 'Clara', 'Oscura']),
            selected: Math.max(0, appearances.indexOf(settings.get_string('appearance'))),
        });
        appearance.connect('notify::selected', () => {
            if (appearance.selected < appearances.length)
                settings.set_string('appearance', appearances[appearance.selected]);
        });
        material.add(appearance);

        const blur = new Adw.SpinRow({
            title: 'Intensidad del cristal',
            subtitle: 'Desenfoque de 0 a 1',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1, step_increment: 0.05, page_increment: 0.1}),
        });
        settings.bind('blur-strength', blur, 'value', Gio.SettingsBindFlags.DEFAULT);
        material.add(blur);

        const desktop = new Adw.SwitchRow({title: 'Redistribuir el escritorio', subtitle: 'Barra modular, dock, menús, calendario y actividades'});
        settings.bind('desktop-style', desktop, 'active', Gio.SettingsBindFlags.DEFAULT);
        material.add(desktop);

        const controls = new Adw.PreferencesGroup({title: 'Interacción'});
        page.add(controls);
        const shortcut = new Adw.EntryRow({
            title: 'Atajo de apertura',
            text: settings.get_strv('toggle-island')[0] ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const value = shortcut.text.trim();
            const [valid, key, modifiers] = Gtk.accelerator_parse(value);
            if (value === '' || (valid && Gtk.accelerator_valid(key, modifiers))) {
                settings.set_strv('toggle-island', value ? [value] : []);
                shortcut.remove_css_class('error');
            } else {
                shortcut.add_css_class('error');
                window.add_toast(new Adw.Toast({title: 'Atajo inválido. Ejemplo: <Super>i'}));
            }
        });
        controls.add(shortcut);
        controls.add(new Adw.ActionRow({
            title: 'Formato del atajo',
            subtitle: 'Ejemplo: <Super>i. Dejá el campo vacío para desactivarlo. Aplicá con el botón de la fila.',
        }));
    }
}
