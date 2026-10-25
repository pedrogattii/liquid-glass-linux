import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';
import {Lifetime} from './lifecycle.js';

// One calendar proxy and one optional weather source for the entire collection.
// All asynchronous completions are scoped to this owner and cancellable.
export class WidgetProviders {
    constructor(settings, changed) {
        this.settings = settings;
        this.changed = changed;
        this.life = new Lifetime();
        this.cancel = new Gio.Cancellable();
        this.events = new Map();
        this.calendar = {available: false, loading: false, events: []};
        this.weather = {available: false, message: 'Configurar una ubicación en Clima', icon: 'weather-clear-symbolic'};
        this.kinds = new Set();
        this.visible = false;
        this.weatherEpoch = 0;
        this.refreshSource = 0;
        this.life.connect(settings, 'changed::widget-weather-location', () => this.loadWeather());
    }

    setActive(kinds, visible) {
        this.kinds = new Set(kinds);
        this.visible = visible;
        if (this.kinds.has('calendar') && !this.calendarStarted)
            this.startCalendar();
        if (this.kinds.has('weather') && visible && !this.weatherStarted)
            this.loadWeather();
        if (!visible || !this.kinds.has('weather')) {
            this.life.cancel(this.refreshSource);
            this.refreshSource = 0;
            this.weatherInfo?.abort();
        } else if (!this.refreshSource) {
            this.weatherInfo?.update();
            this.refreshSource = this.life.timeoutSeconds(1800, () => {
                this.weatherInfo?.update();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    startCalendar() {
        this.calendarStarted = true;
        this.calendar.loading = true;
        let info;
        try {
            info = Gio.DBusInterfaceInfo.new_for_xml(loadInterfaceXML('org.gnome.Shell.CalendarServer'));
        } catch (_) {
            this.calendar.loading = false;
            return;
        }
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            info, 'org.gnome.Shell.CalendarServer', '/org/gnome/Shell/CalendarServer',
            'org.gnome.Shell.CalendarServer', this.cancel, (_source, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    if (!this.life.alive)
                        return;
                    this.calendarProxy = proxy;
                    this.life.connect(proxy, 'notify::g-name-owner', () => {
                        this.events.clear();
                        this.requestMonth(true);
                    });
                    this.life.connect(proxy, 'g-properties-changed', () => this.publishCalendar());
                    this.life.connect(proxy, 'g-signal', (_p, _s, name, params) => {
                        const [items] = params.deep_unpack();
                        if (name === 'EventsAddedOrUpdated') {
                            const replaced = new Set();
                            for (const [id, summary, start, end] of items) {
                                // A recurring update replaces the source's old instances.
                                if (!id.endsWith('\n')) {
                                    const parent = id.substring(0, id.lastIndexOf('\n') + 1);
                                    if (parent && !replaced.has(parent)) {
                                        for (const old of this.events.keys()) {
                                            if (old.startsWith(parent))
                                                this.events.delete(old);
                                        }
                                        replaced.add(parent);
                                    }
                                }
                                this.events.set(id, {id, summary, start: start * 1000, end: end * 1000});
                            }
                        } else if (name === 'EventsRemoved') {
                            for (const id of items)
                                this.events.delete(id);
                        } else if (name === 'ClientDisappeared') {
                            for (const id of this.events.keys()) {
                                if (id.startsWith(`${items}\n`))
                                    this.events.delete(id);
                            }
                        }
                        this.publishCalendar();
                    });
                    this.requestMonth(true);
                } catch (_) {
                    if (this.life.alive) {
                        this.calendar.loading = false;
                        this.changed();
                    }
                }
            });
    }

    requestMonth(force = false) {
        const today = new Date();
        const key = `${today.getFullYear()}-${today.getMonth()}`;
        if (!force && this.monthKey === key)
            return;
        this.monthKey = key;
        this.events.clear();
        const proxy = this.calendarProxy;
        if (!proxy?.g_name_owner) {
            this.publishCalendar();
            return;
        }
        const begin = new Date(today.getFullYear(), today.getMonth(), 1);
        begin.setDate(begin.getDate() - (begin.getDay() + 6) % 7);
        const end = new Date(begin);
        end.setDate(end.getDate() + 42);
        this.calendar.loading = true;
        proxy.call('SetTimeRange', new GLib.Variant('(xxb)',
            [begin.getTime() / 1000, end.getTime() / 1000, true]),
        Gio.DBusCallFlags.NO_AUTO_START, 5000, this.cancel, (p, res) => {
            try { p.call_finish(res); } catch (_) { /* Unavailable calendar is explicit. */ }
            if (this.life.alive)
                this.publishCalendar();
        });
    }

    publishCalendar() {
        this.calendar = {
            available: Boolean(this.calendarProxy?.g_name_owner &&
                this.calendarProxy.get_cached_property('HasCalendars')?.deep_unpack()),
            loading: false,
            events: [...this.events.values()].sort((a, b) => a.start - b.start),
        };
        this.changed();
    }

    async loadWeather() {
        if (!this.kinds.has('weather'))
            return;
        const epoch = ++this.weatherEpoch;
        this.weatherStarted = true;
        this.weatherInfo?.abort();
        if (this.weatherInfo && this.weatherSignal)
            this.weatherInfo.disconnect(this.weatherSignal);
        this.weatherInfo = null;
        this.weatherSignal = 0;
        try {
            const {default: GWeather} = await import('gi://GWeather?version=4.0');
            if (!this.life.alive || epoch !== this.weatherEpoch)
                return;
            const world = GWeather.Location.get_world();
            let location = null;
            const custom = this.settings.get_string('widget-weather-location');
            if (custom)
                location = world.deserialize(GLib.Variant.parse(null, custom, null, null));
            else {
                // Shell mirrors native and Flatpak GNOME Weather configuration here.
                for (const schemaId of ['org.gnome.shell.weather', 'org.gnome.Weather']) {
                    const schema = Gio.SettingsSchemaSource.get_default().lookup(schemaId, true);
                    if (!schema?.has_key('locations'))
                        continue;
                    const config = new Gio.Settings({settings_schema: schema});
                    if (!this.weatherSettings?.some(item => item.schema === schemaId)) {
                        this.weatherSettings ??= [];
                        this.weatherSettings.push({schema: schemaId, config});
                        this.life.connect(config, 'changed::locations', () => this.loadWeather());
                    }
                    const locations = config.get_value('locations');
                    if (locations.n_children() > 0) {
                        let first = locations.get_child_value(0);
                        if (first.is_of_type(new GLib.VariantType('v')))
                            first = first.get_variant();
                        location = world.deserialize(first);
                    }
                    if (location)
                        break;
                }
            }
            if (!location) {
                this.weather = {available: false, message: 'Configurar una ubicación en Clima', icon: 'weather-clear-symbolic'};
                this.changed();
                return;
            }
            const info = new GWeather.Info({location,
                application_id: 'org.gnome.shell.extensions.liquid-island',
                contact_info: 'https://github.com/pedrogattii/liquid-glass-linux',
                enabled_providers: GWeather.Provider.METAR | GWeather.Provider.MET_NO});
            this.weatherInfo = info;
            this.weatherSignal = info.connect('updated', () => {
                if (!this.life.alive || epoch !== this.weatherEpoch)
                    return;
                this.weather = {available: info.is_valid(), location: location.get_name(),
                    temperature: info.is_valid() ? info.get_temp_summary() : '',
                    message: info.is_valid() ? info.get_conditions() : 'Pronóstico no disponible',
                    icon: info.get_symbolic_icon_name() || 'weather-clear-symbolic'};
                this.changed();
            });
            this.weather = {available: false, location: location.get_name(), message: 'Cargando pronóstico…', icon: 'weather-clear-symbolic'};
            this.changed();
            if (this.visible)
                info.update();
        } catch (_) {
            if (this.life.alive && epoch === this.weatherEpoch) {
                this.weather = {available: false, message: 'Clima no disponible. Comprobá GWeather y la ubicación.', icon: 'weather-clear-symbolic'};
                this.changed();
            }
        }
    }

    destroy() {
        this.weatherEpoch++;
        this.cancel.cancel();
        this.weatherInfo?.abort();
        if (this.weatherInfo && this.weatherSignal)
            this.weatherInfo.disconnect(this.weatherSignal);
        this.weatherInfo = null;
        this.life.destroy();
        this.changed = () => {};
        this.calendarProxy = null;
    }
}
