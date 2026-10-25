// Run with: node --experimental-vm-modules tests/music-service.mjs
// Fully isolated fake session bus: this test never accesses the running desktop.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class Emitter {
    constructor() { this.signals = new Map(); this.serial = 0; }
    connect(name, callback) { const id = ++this.serial; this.signals.set(id, [name, callback]); return id; }
    disconnect(id) { this.signals.delete(id); }
    emit(name, ...args) {
        for (const [signal, callback] of [...this.signals.values()]) {
            if (signal === name) callback(this, ...args);
        }
    }
}
const variant = value => ({deep_unpack: () => value,
    get_child_value: index => ({get_variant: () => ({get_int64: () => value[index]})})});
class Cancellable {
    constructor() { this.cancelled = false; }
    cancel() { this.cancelled = true; }
    is_cancelled() { return this.cancelled; }
}
const system = new Emitter();
const apps = new Map();
system.get_installed = () => [...apps.values()].map(app => app.get_app_info());
system.get_running = () => [...apps.values()].filter(app => app.state !== 0);
system.lookup_app = id => apps.get(id) ?? null;
const app = (id, name, categories) => {
    const value = {state: 0, activations: 0, get_id: () => id, get_name: () => name,
        get_state() { return this.state; }, activate() { this.activations++; },
        get_app_info: () => ({get_id: () => id, get_categories: () => categories})};
    apps.set(id, value);
    return value;
};
const spotify = app('com.spotify.Client.desktop', 'Spotify', 'Audio;Music;Player;');
const browser = app('firefox.desktop', 'Firefox', 'WebBrowser;');
const names = new Map();
const owners = new Set();
const proxies = [];
const descriptions = new Map();
const calls = [];
let nameCallback;
let held = false;
const pending = [];
let holdPositionReplies = false;
const pendingPositions = [];
const bus = {
    signal_subscribe(_sender, _iface, _signal, _path, _arg, _flags, callback) {
        nameCallback = callback; return 1;
    },
    signal_unsubscribe() { nameCallback = null; },
    call(name, _path, iface, method, args, _reply, flags, _timeout, _cancel, callback) {
        calls.push({name, iface, method, flags});
        queueMicrotask(() => {
            let value;
            if (method === 'ListNames') value = [[...names.keys(), ...owners]];
            else if (method === 'GetNameOwner') value = [names.get(args.value[0]) ?? ''];
            else if (method === 'Get') value = [descriptions.get(name)?.position ?? 0];
            else value = [];
            const reply = variant(value);
            const complete = () => callback(bus, reply);
            if (method === 'Get' && holdPositionReplies)
                pendingPositions.push(complete);
            else
                complete();
        });
    },
    call_finish: result => result,
};
class Proxy extends Emitter {
    constructor(owner, iface) { super(); this.owner = owner; this.iface = iface; }
    get_cached_property(key) {
        const value = descriptions.get(this.owner)?.[this.iface.endsWith('.Player') ? 'player' : 'root']?.[key];
        return value === undefined ? null : variant(value);
    }
    call(method, _args, flags, _timeout, _cancel, callback) {
        calls.push({name: this.owner, method, flags});
        queueMicrotask(() => callback(this, variant([])));
    }
    call_finish() {}
}
const Gio = {_promisify() {}, Cancellable, DBus: {session: bus},
    DBusCallFlags: {NO_AUTO_START: 1}, DBusSignalFlags: {NONE: 0}, BusType: {SESSION: 0},
    DBusProxyFlags: {DO_NOT_AUTO_START: 1, GET_INVALIDATED_PROPERTIES: 2},
    DBusProxy: {
        new_for_bus(_bus, flags, _info, owner, _path, iface, _cancel, callback) {
            assert.ok(flags & 1, 'proxy discovery cannot activate apps');
            const proxy = new Proxy(owner, iface); proxies.push(proxy);
            const complete = () => callback(null, proxy);
            if (held) pending.push(complete); else queueMicrotask(complete);
        },
        new_for_bus_finish: ready => ready,
    }, InputStream: class {}, File: class {}, IOErrorEnum: {CANCELLED: 1},
};
let ticks = 0;
const GLib = {get_monotonic_time: () => ++ticks,
    Variant: class {constructor(_type, value) { this.value = value; }},
    VariantType: class {constructor(type) { this.type = type; }},
};
class Session { abort() { this.aborted = true; } }
const context = vm.createContext({console});
const fakes = new Map([
    ['gi://Gio', Gio], ['gi://GLib', GLib], ['gi://Shell', {AppSystem: {get_default: () => system},
        AppState: {STOPPED: 0, STARTING: 1, RUNNING: 2}}],
    ['gi://Soup?version=3.0', {Session}], ['gi://GdkPixbuf', {Pixbuf: class {}}],
]);
const modules = new Map();
async function moduleFor(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    let module;
    if (fakes.has(identifier)) {
        module = new vm.SyntheticModule(['default'], function () { this.setExport('default', fakes.get(identifier)); }, {context});
    } else {
        module = new vm.SourceTextModule(await readFile(new URL(identifier), 'utf8'), {context, identifier});
    }
    modules.set(identifier, module);
    await module.link((specifier, parent) => moduleFor(specifier.startsWith('gi://') ?
        specifier : new URL(specifier, parent.identifier).href));
    return module;
}
const source = await moduleFor(new URL('../extensions/liquid-island@pedrogatti.local/lib/music.js', import.meta.url).href);
await source.evaluate();
const {Music} = source.namespace;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const ownerChange = (name, previous, owner) => {
    if (name.startsWith(':')) {
        if (owner) owners.add(owner); else owners.delete(name);
    } else if (owner) { names.set(name, owner); owners.add(owner); } else names.delete(name);
    nameCallback?.(null, null, null, null, null, variant([name, previous, owner]));
};
const props = (owner, iface, changed) => {
    Object.assign(descriptions.get(owner)[iface], changed);
    for (const proxy of proxies.filter(item => item.owner === owner &&
        item.iface.endsWith('.Player') === (iface === 'player')))
        proxy.emit('g-properties-changed');
};
const description = (identity, desktopEntry, status = 'Paused') => ({
    root: {Identity: identity, DesktopEntry: desktopEntry, CanRaise: true},
    player: {PlaybackStatus: status, Metadata: {'xesam:title': 'Song', 'xesam:artist': ['Artist'],
        'mpris:trackid': '/track/1', 'mpris:length': 1000000}, CanControl: true, CanPlay: true,
    CanPause: true, CanSeek: true, CanGoNext: true, CanGoPrevious: false}, position: 10,
});
let notifications = 0;
const music = new Music(() => notifications++);
await settle();
assert.equal(music.state.present, false);
spotify.state = 1; system.emit('app-state-changed', spotify);
assert.equal(music.state.present, true, 'native startup visible before MPRIS');
assert.equal(music.state.connected, false);
assert.equal(music.state.canPlay, false);
assert.equal(music.state.identity, 'Spotify');
let subscribed = 0;
const unsubscribe = music.subscribe(() => subscribed++);
assert.equal(subscribed, 1);
const spotifyName = 'org.mpris.MediaPlayer2.spotify';
descriptions.set(':1.10', description('Spotify', 'spotify'));
ownerChange(spotifyName, '', ':1.10');
await settle();
assert.equal(music.state.players.length, 1, 'native/Flatpak desktop aliases do not duplicate a player');
assert.equal(music.state.connected, true);
assert.equal(music.state.playing, false, 'paused session remains present');
assert.equal(music.state.canPrevious, false, 'unsupported controls stay disabled');
assert.equal(music.state.title, 'Song');
holdPositionReplies = true;
music.refreshPosition();
await settle();
assert.equal(pendingPositions.length, 1, 'hold the older Position Get reply');
const playerProxy = proxies.find(proxy => proxy.owner === ':1.10' && proxy.iface.endsWith('.Player'));
playerProxy.emit('g-signal', ':1.10', 'Seeked', variant([800000]));
assert.equal(music.state.position, 800000, 'Seeked immediately establishes the newer position');
holdPositionReplies = false;
for (const complete of pendingPositions.splice(0)) complete();
await settle();
assert.equal(music.state.position, 800000, 'older Position Get cannot rewind a newer Seeked event');
assert.equal(calls.some(call => call.method === 'Raise'), false, 'discovery never raises or launches app');
assert.equal(spotify.activations, 0);
const browserName = 'org.mpris.MediaPlayer2.firefox.instance1';
browser.state = 2;
descriptions.set(':1.11', description('Firefox', 'firefox', 'Playing'));
ownerChange(browserName, '', ':1.11');
await settle();
assert.equal(music.state.name, browserName, 'playing browser MPRIS outranks paused native player');
assert.equal(music.selectPlayer(spotifyName), true);
props(':1.11', 'player', {PlaybackStatus: 'Playing'});
assert.equal(music.state.name, spotifyName, 'manual choice remains sticky');
music.raise(); await settle();
assert.equal(calls.filter(call => call.method === 'Raise').at(-1).iface, 'org.mpris.MediaPlayer2');
assert.equal(spotify.activations, 0, 'successful MPRIS Raise does not also activate a fallback app');
props(':1.10', 'root', {CanRaise: false});
spotify.state = 2; system.emit('app-state-changed', spotify);
music.raise();
assert.equal(spotify.activations, 1, 'unsupported Raise focuses the matching running app');
spotify.state = 0; system.emit('app-state-changed', spotify);
ownerChange(spotifyName, ':1.10', '');
await settle();
assert.equal(music.state.name, spotifyName);
assert.equal(music.state.present, true, 'unique bus owner preserves background native presence');
assert.equal(music.state.connected, false);
assert.equal(music.state.canPlay, false);
ownerChange(':1.10', ':1.10', '');
await settle();
assert.equal(music.state.name, browserName, 'actual owner exit removes native presence');
ownerChange(browserName, ':1.11', '');
await settle();
assert.equal(music.state.present, false, 'browser application alone cannot create idle player');
// Hold proxy replies while the same well-known name changes owner, then deliver stale replies.
held = true;
descriptions.set(':1.20', description('Old', 'vlc'));
ownerChange('org.mpris.MediaPlayer2.vlc', '', ':1.20');
await settle();
descriptions.set(':1.21', description('New', 'vlc'));
ownerChange('org.mpris.MediaPlayer2.vlc', ':1.20', ':1.21');
await settle();
held = false;
for (const complete of pending.splice(0)) complete();
await settle();
assert.equal(music.state.identity, 'New', 'stale owner proxy replies cannot replace current state');
assert.ok(proxies.filter(proxy => proxy.owner === ':1.20').every(proxy => proxy.signals.size === 0));
unsubscribe(); const lastSubscribed = subscribed;
props(':1.21', 'player', {PlaybackStatus: 'Playing'});
assert.equal(subscribed, lastSubscribed);
held = true;
descriptions.set(':1.22', description('Late', 'other'));
ownerChange('org.mpris.MediaPlayer2.other', '', ':1.22');
await settle();
music.destroy();
const lastNotifications = notifications;
for (const complete of pending.splice(0)) complete();
await settle();
assert.equal(notifications, lastNotifications, 'late callbacks cannot emit after destruction');
assert.equal(system.signals.size, 0);
assert.equal(nameCallback, null);
assert.ok(proxies.every(proxy => proxy.signals.size === 0), 'all proxy signal handlers are disconnected');
assert.ok(calls.every(call => call.flags === 1), 'every bus call prohibits automatic startup');
console.log('music service: startup, pause, selection, browser exclusion, Raise, seek/owner races and cleanup passed');
