import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

// Substitute the bus and clock so cleanup/race behavior can be checked without
// starting a Shell process, touching the desktop or fetching weather data.
const source = (await readFile(new URL('../extensions/liquid-island@pedrogatti.local/lib/widgetProviders.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace('export class WidgetProviders', 'return class WidgetProviders');
function fixture() {
    let callback;
    let requests = 0;
    let changed = 0;
    const signals = new Map();
    class Lifetime {
        alive = true;
        sources = new Set();
        connect(object, name, cb) {
            const key = `${object.name || 'settings'}:${name}`;
            signals.set(key, cb);
            return key;
        }
        cancel(id) { this.sources.delete(id); }
        timeoutSeconds(_seconds, cb) { this.sources.add(cb); return cb; }
        destroy() { this.alive = false; signals.clear(); this.sources.clear(); }
    }
    const proxy = {name: 'proxy', g_name_owner: ':1.20',
        get_cached_property: () => ({deep_unpack: () => true}),
        call(_method, args, _flags, _timeout, _cancel, cb) {
            requests++;
            assert.equal(args.type, '(xxb)');
            assert.equal(args.values[1] - args.values[0], 42 * 24 * 60 * 60);
            cb(proxy, {});
        }, call_finish() {}};
    const Gio = {
        Cancellable: class {cancel() { this.cancelled = true; }},
        DBusInterfaceInfo: {new_for_xml: () => ({})},
        DBusProxy: {new_for_bus(...args) { callback = args.at(-1); },
            new_for_bus_finish: () => proxy},
        BusType: {SESSION: 1}, DBusProxyFlags: {DO_NOT_AUTO_START: 1},
        DBusCallFlags: {NO_AUTO_START: 1},
    };
    const GLib = {Variant: class {constructor(type, values) { this.type = type; this.values = values; }}, SOURCE_CONTINUE: true};
    const Providers = new Function('Gio', 'GLib', 'loadInterfaceXML', 'Lifetime', source)(Gio, GLib, () => '<interface/>', Lifetime);
    const owner = new Providers({}, () => changed++);
    return {owner, signals, proxy, finish: () => callback(null, {}),
        requests: () => requests, changed: () => changed};
}

test('all calendar consumers share one proxy and month request', () => {
    const f = fixture();
    f.owner.setActive(['calendar'], false);
    f.owner.setActive(['calendar', 'clock'], false);
    f.finish();
    assert.equal(f.requests(), 1);
    f.owner.requestMonth();
    assert.equal(f.requests(), 1);
    assert.equal(f.owner.calendar.available, true);
    f.owner.destroy();
    assert.equal(f.owner.cancel.cancelled, true);
    assert.equal(f.signals.size, 0);
});

test('calendar bus events populate and remove real appointments', () => {
    const f = fixture();
    f.owner.setActive(['calendar'], false);
    f.finish();
    const event = f.signals.get('proxy:g-signal');
    event(null, null, 'EventsAddedOrUpdated', {deep_unpack: () => [[['source\n1', 'Appointment', 1000, 2000, {}]]]});
    assert.deepEqual(f.owner.calendar.events, [{id: 'source\n1', summary: 'Appointment', start: 1000000, end: 2000000}]);
    event(null, null, 'EventsRemoved', {deep_unpack: () => [['source\n1']]});
    assert.deepEqual(f.owner.calendar.events, []);
    f.proxy.g_name_owner = null;
    f.signals.get('proxy:notify::g-name-owner')();
    assert.equal(f.owner.calendar.available, false);
    f.owner.destroy();
});

test('late calendar proxy completion after destroy does not reconnect or render', () => {
    const f = fixture();
    f.owner.setActive(['calendar'], false);
    f.owner.destroy();
    f.finish();
    assert.equal(f.requests(), 0);
    assert.equal(f.changed(), 0);
    assert.equal(f.signals.size, 0);
});

test('unmapped providers cancel refresh sources and abort pending weather', () => {
    const f = fixture();
    let aborts = 0;
    f.owner.weatherStarted = true;
    f.owner.weatherInfo = {update() {}, abort() { aborts++; }};
    f.owner.setActive(['weather'], true);
    assert.equal(f.owner.life.sources.size, 1);
    f.owner.setActive(['weather'], false);
    assert.equal(f.owner.life.sources.size, 0);
    assert.equal(aborts, 1);
    f.owner.destroy();
});
