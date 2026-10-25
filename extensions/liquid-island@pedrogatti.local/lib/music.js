import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import {Lifetime} from './lifecycle.js';
import {positionAt, extractDominantColor} from './policy.js';
import {MPRIS_PREFIX, DEFAULT_ACCENT, MAX_COVER_BYTES, desktopId, sameDesktopApp, nativeMusicApp,
    playerPresent, orderPlayers, selectPlayerName, mediaMetadata, mediaCapabilities,
    artworkUriAllowed, localArtworkAllowed} from './musicPolicy.js';

const PATH = '/org/mpris/MediaPlayer2';
const ROOT = 'org.mpris.MediaPlayer2';
const IFACE = `${ROOT}.Player`;
const NOW = () => GLib.get_monotonic_time();
const FLAGS = Gio.DBusCallFlags.NO_AUTO_START;
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

function busCall(name, path, iface, method, args, reply, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(name, path, iface, method, args, reply, FLAGS,
            2500, cancellable, (bus, result) => {
                try { resolve(bus.call_finish(result)); } catch (error) { reject(error); }
            });
    });
}

function newProxy(owner, iface, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
            null, owner, PATH, iface, cancellable, (_source, result) => {
                try { resolve(Gio.DBusProxy.new_for_bus_finish(result)); }
                catch (error) { reject(error); }
            });
    });
}

function property(proxy, key, fallback) {
    return proxy?.get_cached_property(key)?.deep_unpack() ?? fallback;
}

export class Music {
    constructor(changed = null) {
        this.life = new Lifetime();
        this.changed = changed;
        this.listeners = new Set();
        this.cancel = new Gio.Cancellable();
        this.records = new Map();
        this.apps = new Map();
        this.manualSelection = null;
        this.selectedName = null;
        this.proxy = null;
        this.epoch = 0;
        this.coverEpoch = 0;
        this.coverCancel = null;
        this.discoveryCancel = null;
        this.state = this.empty();
        this.session = new Soup.Session({timeout: 8, max_conns: 1, max_conns_per_host: 1});
        this.appSystem = Shell.AppSystem.get_default();
        this.life.connect(this.appSystem, 'app-state-changed', (_system, app) => {
            this.rememberApp(app);
            this.sync();
        });
        this.life.connect(this.appSystem, 'installed-changed', () => {
            this.scanApps();
            this.sync();
        });
        this.nameSignal = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                if (!this.life.alive)
                    return;
                const [name, , owner] = params.deep_unpack();
                if (name.startsWith(MPRIS_PREFIX)) {
                    this.setOwner(name, owner);
                    this.discover();
                } else if (name.startsWith(':') && !owner) {
                    // A surviving unique connection is stronger evidence than window count.
                    for (const record of this.records.values()) {
                        if (record.owner === name) {
                            record.ownerAlive = false;
                            if (record.connected)
                                this.setOwner(record.name, '');
                        }
                    }
                    this.sync();
                }
            });
        this.scanApps();
        this.sync();
        this.discover();
    }

    empty() {
        return {present: false, connected: false, name: null, identity: 'Música',
            desktopEntry: '', title: 'Música', artist: 'Sin reproducción', album: '',
            playing: false, length: 0, position: 0, at: NOW(), track: '/',
            canPlay: false, canPause: false, canSeek: false, canNext: false,
            canPrevious: false, canRaise: false, art: '', cover: null,
            accentColor: DEFAULT_ACCENT, players: []};
    }

    get players() {
        return this.state.players;
    }

    subscribe(callback) {
        if (!this.life.alive)
            return () => {};
        this.listeners.add(callback);
        try { callback(this.state); } catch (error) { this.report(error); }
        return () => this.listeners.delete(callback);
    }

    emit() {
        if (!this.life.alive)
            return;
        for (const callback of [this.changed, ...this.listeners]) {
            try { callback?.(this.state); } catch (error) { this.report(error); }
        }
    }

    rememberApp(app) {
        const id = app?.get_id();
        if (!id)
            return;
        const info = app.get_app_info();
        if (!nativeMusicApp(id, info?.get_categories?.() ?? '')) {
            this.apps.delete(id);
            return;
        }
        if (app.get_state() === Shell.AppState.STOPPED)
            this.apps.delete(id);
        else
            this.apps.set(id, app);
    }

    scanApps() {
        this.apps.clear();
        for (const info of this.appSystem.get_installed()) {
            const id = info.get_id();
            if (nativeMusicApp(id, info.get_categories?.() ?? ''))
                this.rememberApp(this.appSystem.lookup_app(id));
        }
        for (const app of this.appSystem.get_running())
            this.rememberApp(app);
    }

    appFor(record) {
        const entry = desktopId(property(record.root, 'DesktopEntry', record.desktopEntry ?? ''));
        const short = record.name.slice(MPRIS_PREFIX.length).split('.')[0];
        const ids = [entry, `${short}.desktop`];
        // Spotify's native and Flatpak desktop IDs describe the same native app.
        if (short.toLowerCase() === 'spotify')
            ids.push('spotify.desktop', 'com.spotify.Client.desktop');
        for (const id of ids.filter(Boolean)) {
            const app = this.appSystem.lookup_app(id);
            if (app)
                return app;
        }
        return null;
    }

    async discover() {
        const epoch = ++this.epoch;
        this.discoveryCancel?.cancel();
        const cancellable = new Gio.Cancellable();
        this.discoveryCancel = cancellable;
        try {
            const [names] = (await busCall('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
                cancellable)).deep_unpack();
            const owners = await Promise.all(names.filter(name => name.startsWith(MPRIS_PREFIX))
                .map(async name => {
                    try {
                        const [owner] = (await busCall('org.freedesktop.DBus', '/org/freedesktop/DBus',
                            'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', [name]),
                            new GLib.VariantType('(s)'), cancellable)).deep_unpack();
                        return [name, owner];
                    } catch (_) { return [name, '']; }
                }));
            if (!this.life.alive || epoch !== this.epoch)
                return;
            const available = new Map(owners);
            for (const record of this.records.values()) {
                record.ownerAlive = names.includes(record.owner);
                if (!available.get(record.name) && record.connected)
                    this.setOwner(record.name, '');
            }
            for (const [name, owner] of owners) {
                if (owner)
                    this.setOwner(name, owner);
            }
            this.sync();
        } catch (error) { this.report(error); }
    }

    setOwner(name, owner) {
        let record = this.records.get(name);
        if (record?.connected && record.owner === owner)
            return;
        if (record) {
            this.disconnectRecord(record);
            record.connected = false;
        }
        if (!owner) {
            this.sync();
            return;
        }
        record = {name, owner, ownerAlive: true, connected: true, ready: false,
            signals: [], cancel: new Gio.Cancellable(), generation: 0,
            position: 0, at: NOW(), playing: false, track: '/', root: null, player: null};
        this.records.set(name, record);
        this.sync();
        this.attach(record);
    }

    current(record, generation = record.generation) {
        return this.life.alive && this.records.get(record.name) === record &&
            record.connected && record.generation === generation && !record.cancel.is_cancelled();
    }

    async attach(record) {
        const generation = record.generation;
        const results = await Promise.allSettled([
            newProxy(record.owner, ROOT, record.cancel),
            newProxy(record.owner, IFACE, record.cancel),
        ]);
        if (!this.current(record, generation))
            return;
        // Root metadata is optional for imperfect players; controls still require Player.
        if (results[0].status === 'fulfilled')
            record.root = results[0].value;
        if (results[1].status === 'rejected') {
            this.report(results[1].reason);
            record.ready = false;
            this.sync();
            return;
        }
        record.player = results[1].value;
        record.ready = true;
        for (const proxy of [record.root, record.player].filter(Boolean)) {
            record.signals.push([proxy, proxy.connect('g-properties-changed', () => {
                if (this.current(record, generation))
                    this.sync();
            })]);
        }
        record.signals.push([record.player, record.player.connect('g-signal', (_p, _s, signal, params) => {
            if (signal === 'Seeked' && this.current(record, generation)) {
                // The signal is newer than any Position Get already in flight.
                record.positionRequest = (record.positionRequest ?? 0) + 1;
                record.position = params.deep_unpack()[0];
                record.at = NOW();
                this.sync();
            }
        })]);
        this.sync();
        if (this.selectedName !== record.name)
            this.refreshRecordPosition(record);
    }

    disconnectRecord(record) {
        record.generation++;
        record.cancel.cancel();
        for (const [proxy, signal] of record.signals)
            proxy.disconnect(signal);
        record.signals = [];
        record.player = null;
        record.root = null;
        record.ready = false;
        record.playing = false;
    }

    describe(record) {
        const app = this.appFor(record);
        const desktopEntry = property(record.root, 'DesktopEntry', '') ||
            app?.get_id()?.replace(/\.desktop$/, '') || record.desktopEntry || '';
        const identity = property(record.root, 'Identity', '') || app?.get_name() ||
            record.identity || 'Reproductor multimedia';
        const info = app?.get_app_info();
        const native = nativeMusicApp(desktopId(desktopEntry), info?.get_categories?.() ?? '');
        const appRunning = app && app.get_state() !== Shell.AppState.STOPPED;
        record.desktopEntry = desktopEntry;
        record.identity = identity;
        const playing = record.ready && property(record.player, 'PlaybackStatus', 'Stopped') === 'Playing';
        return {name: record.name, identity, desktopEntry, connected: record.connected,
            playing, present: playerPresent({connected: record.connected, native,
                appRunning, ownerAlive: record.ownerAlive}), selected: false};
    }

    selectPlayer(name) {
        if (name === null) {
            this.manualSelection = null;
        } else {
            const player = this.players.find(candidate => candidate.name === name && candidate.present);
            if (!player)
                return false;
            this.manualSelection = {name, desktopEntry: player.desktopEntry};
        }
        this.sync();
        return true;
    }

    get(key, fallback) {
        const record = this.records.get(this.selectedName);
        return property(['Identity', 'DesktopEntry', 'CanRaise'].includes(key) ?
            record?.root : this.proxy, key, fallback);
    }

    sync() {
        if (!this.life.alive)
            return;
        const old = this.state;
        const descriptors = [];
        for (const [name, record] of this.records) {
            const descriptor = this.describe(record);
            if (descriptor.present)
                descriptors.push(descriptor);
            else {
                this.disconnectRecord(record);
                this.records.delete(name);
            }
        }
        for (const [id, app] of this.apps) {
            if (app.get_state() === Shell.AppState.STOPPED)
                continue;
            if (descriptors.some(player => sameDesktopApp(player.desktopEntry, id)))
                continue;
            descriptors.push({name: `app:${id}`, identity: app.get_name(),
                desktopEntry: id.replace(/\.desktop$/, ''), present: true,
                connected: false, playing: false, selected: false});
        }
        const selectedName = selectPlayerName(descriptors, this.manualSelection, this.selectedName);
        const selected = descriptors.find(player => player.name === selectedName);
        if (this.manualSelection) {
            const available = descriptors.find(player => player.name === this.manualSelection.name ||
                (this.manualSelection.desktopEntry && sameDesktopApp(player.desktopEntry, this.manualSelection.desktopEntry)));
            if (!available)
                this.manualSelection = null;
        }
        this.selectedName = selectedName;
        const players = orderPlayers(descriptors).map(player => ({...player,
            selected: player.name === selectedName}));
        const record = this.records.get(selectedName);
        const app = record ? this.appFor(record) :
            this.appSystem.lookup_app(desktopId(selected?.desktopEntry));
        const canFocusApp = Boolean(app && app.get_state() !== Shell.AppState.STOPPED);
        this.proxy = record?.ready ? record.player : null;
        const changedPlayer = old.name !== selectedName;
        let refresh = false;
        if (selected && record?.ready) {
            const meta = mediaMetadata(property(record.player, 'Metadata', {}), selected.identity);
            const now = NOW();
            const changedTrack = record.track !== meta.track ||
                (old.name === selectedName && (old.title !== meta.title || old.artist !== meta.artist));
            const position = changedTrack ? 0 : positionAt(record.position, record.at,
                record.playing, meta.length, now);
            refresh = changedPlayer || changedTrack || record.playing !== selected.playing;
            record.position = position;
            record.at = now;
            record.track = meta.track;
            record.playing = selected.playing;
            const retainCover = !changedPlayer && old.art === meta.art;
            this.state = {...this.empty(), ...selected, ...meta, players,
                position, at: now, ...mediaCapabilities((key, fallback) =>
                    property(record.player, key, fallback), record.connected),
                canRaise: property(record.root, 'CanRaise', false) ||
                    canFocusApp,
                cover: retainCover ? old.cover : null,
                accentColor: retainCover ? old.accentColor : DEFAULT_ACCENT};
        } else {
            this.state = {...this.empty(), ...selected, name: selectedName, players,
                title: selected?.identity ?? 'Música', canRaise: canFocusApp};
        }
        if (changedPlayer || old.art !== this.state.art) {
            this.coverCancel?.cancel();
            this.coverEpoch++;
            if (this.state.art)
                this.loadCover(this.state.art);
        }
        this.emit();
        if (refresh && record)
            this.refreshRecordPosition(record);
    }

    raise() {
        const record = this.records.get(this.selectedName);
        const name = this.selectedName;
        const fallback = () => {
            if (!this.life.alive || name !== this.selectedName)
                return;
            const app = record ? this.appFor(record) :
                this.appSystem.lookup_app(desktopId(this.state.desktopEntry));
            // An explicit user action may focus an existing app; discovery never activates one.
            if (app && app.get_state() !== Shell.AppState.STOPPED)
                app.activate();
        };
        if (!record?.ready || !property(record.root, 'CanRaise', false)) {
            fallback();
            return;
        }
        busCall(record.owner, PATH, ROOT, 'Raise', null, null, record.cancel)
            .catch(error => {
                if (this.current(record)) {
                    this.report(error);
                    fallback();
                }
            });
    }

    position() {
        return positionAt(this.state.position, this.state.at, this.state.playing,
            this.state.length, NOW());
    }

    getPosition() {
        return this.position();
    }

    refreshPosition() {
        const record = this.records.get(this.selectedName);
        if (record)
            this.refreshRecordPosition(record);
    }

    async refreshRecordPosition(record) {
        if (!record.ready || !this.current(record))
            return;
        const generation = record.generation;
        const track = record.track;
        const request = (record.positionRequest ?? 0) + 1;
        record.positionRequest = request;
        try {
            const reply = await busCall(record.owner, PATH, 'org.freedesktop.DBus.Properties',
                'Get', new GLib.Variant('(ss)', [IFACE, 'Position']),
                new GLib.VariantType('(v)'), record.cancel);
            if (!this.current(record, generation) || record.track !== track ||
                record.positionRequest !== request)
                return;
            record.position = reply.get_child_value(0).get_variant().get_int64();
            record.at = NOW();
            if (this.selectedName === record.name)
                this.sync();
        } catch (error) { this.report(error); }
    }

    command(method) {
        const key = {Previous: 'canPrevious', Next: 'canNext', Play: 'canPlay',
            Pause: 'canPause', PlayPause: this.state.playing ? 'canPause' : 'canPlay'}[method];
        if (key && this.state[key])
            this.call(method, null);
    }

    seek(fraction) {
        if (!this.state.canSeek || !Number.isFinite(fraction) ||
            this.state.length <= 0 || this.state.track === '/' ||
            this.state.track === '/org/mpris/MediaPlayer2/TrackList/NoTrack')
            return;
        const position = Math.round(Math.max(0, Math.min(1, fraction)) * this.state.length);
        this.call('SetPosition', new GLib.Variant('(ox)', [this.state.track, position]));
    }

    call(method, args) {
        const record = this.records.get(this.selectedName);
        if (!record?.ready || !this.current(record))
            return;
        const generation = record.generation;
        record.player.call(method, args, FLAGS, 2500, record.cancel, (proxy, result) => {
            try {
                proxy.call_finish(result);
                if (this.current(record, generation))
                    this.refreshRecordPosition(record);
            } catch (error) { this.report(error); }
        });
    }

    async loadCover(uri) {
        this.coverCancel?.cancel();
        const epoch = ++this.coverEpoch;
        const cancellable = new Gio.Cancellable();
        this.coverCancel = cancellable;
        if (!artworkUriAllowed(uri))
            return;
        let stream;
        let input;
        try {
            if (uri.startsWith('file://')) {
                const file = Gio.File.new_for_uri(uri);
                const info = await file.query_info_async('standard::type,standard::size,standard::content-type',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
                if (!localArtworkAllowed({regular: info.get_file_type() === Gio.FileType.REGULAR,
                    size: info.get_size(), contentType: info.get_content_type()}))
                    return;
                stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
            } else {
                const message = Soup.Message.new('GET', uri);
                message.flags |= Soup.MessageFlags.NO_REDIRECT;
                stream = await this.session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
                if (message.status_code !== 200 ||
                    message.response_headers.get_content_length() > MAX_COVER_BYTES)
                    return;
            }
            const chunks = [];
            let total = 0;
            while (total <= MAX_COVER_BYTES) {
                if (!this.life.alive || epoch !== this.coverEpoch)
                    return;
                const chunk = await stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable);
                if (!chunk.get_size())
                    break;
                chunks.push(chunk.get_data());
                total += chunk.get_size();
            }
            if (total > MAX_COVER_BYTES || !this.life.alive || epoch !== this.coverEpoch)
                return;
            const data = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
            input = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data));
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(input,
                192, 192, true, cancellable);
            if (!this.life.alive || epoch !== this.coverEpoch)
                return;
            this.state.accentColor = extractDominantColor(pixbuf);
            const [ok, thumbnail] = pixbuf.save_to_bufferv('png', [], []);
            if (ok)
                this.state.cover = Gio.BytesIcon.new(GLib.Bytes.new(thumbnail));
            this.emit();
        } catch (_) {
            // Artwork is optional. Cancellation and invalid images keep the placeholder.
        } finally {
            try { input?.close(null); } catch (_) { /* optional artwork */ }
            if (stream) {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try { source.close_finish(result); } catch (_) { /* optional artwork */ }
                });
            }
        }
    }

    report(error) {
        if (this.life.alive && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.debug(`Liquid Island MPRIS: ${error.message}`);
    }

    destroy() {
        this.life.destroy();
        this.epoch++;
        this.cancel.cancel();
        this.discoveryCancel?.cancel();
        this.coverCancel?.cancel();
        this.coverEpoch++;
        for (const record of this.records.values())
            this.disconnectRecord(record);
        this.records.clear();
        this.apps.clear();
        this.listeners.clear();
        this.changed = null;
        this.proxy = null;
        if (this.nameSignal) {
            Gio.DBus.session.signal_unsubscribe(this.nameSignal);
            this.nameSignal = 0;
        }
        this.session.abort();
    }
}
