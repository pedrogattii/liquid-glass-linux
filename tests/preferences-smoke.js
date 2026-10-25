import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory' || !GLib.getenv('LIQUID_ISOLATED_TEST'))
    throw new Error('Run only in isolated test compositor with memory settings');
Adw.init();
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const extension = root.get_child('extensions/liquid-island@pedrogatti.local');
const Prefs = (await import(extension.get_child('prefs.js').get_uri())).default;
const [, raw] = extension.get_child('metadata.json').load_contents(null);
const metadata = {...JSON.parse(new TextDecoder().decode(raw)), dir: extension, path: extension.get_path()};
const prefs = new Prefs(metadata);
const settings = prefs.getSettings();
const window = new Adw.PreferencesWindow();
prefs.fillPreferencesWindow(window);
const all = [];
function visit(widget) {
    all.push(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) visit(child);
}
visit(window);
const find = (klass, title) => all.find(w => w instanceof klass && w.title === title);
const dock = find(Adw.ComboRow, 'Borde del dock');
if (!dock) throw new Error('Distribution page missing');
settings.set_string('dock-position', 'left');
if (dock.selected !== 2) throw new Error('Dock choice does not sync');
settings.reset('dock-position');
if (dock.selected !== 0) throw new Error('Dock reset does not sync');
settings.set_int('widget-timer-seconds', 300);
if (find(Adw.SpinRow, 'Duración del temporizador (segundos)').value !== 300)
    throw new Error('Timer control does not sync');
const clock = all.find(w => w instanceof Adw.ExpanderRow && w.title === 'Reloj');
if (!clock) throw new Error('Clock widget settings missing');
settings.set_string('widget-layout', JSON.stringify({version:1,widgets:{clock:{monitor:'',x:120,y:96,width:300,height:180}}}));
settings.reset('widget-layout');
if (settings.get_string('widget-layout') !== '{"version":1,"widgets":{}}')
    throw new Error('Reset wrote stale widget layout');
window.present();
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
    window.destroy();
    print(`preferences smoke: full window constructed; ${all.filter(w => w instanceof Adw.PreferencesPage).length} pages; external changes and reset passed`);
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
