import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import {Lifetime} from './lifecycle.js';
import {choosePlayer, positionAt, coverUriAllowed} from './policy.js';

const PATH = '/org/mpris/MediaPlayer2';
const IFACE = 'org.mpris.MediaPlayer2.Player';
const NOW = () => GLib.get_monotonic_time();
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

export class Music {
    constructor(changed) {
        this.life = new Lifetime();
        this.changed = changed;
        this.cancel = new Gio.Cancellable();
        this.proxy = null;
        this.proxySignals = [];
        this.epoch = 0;
        this.state = this.empty();
        this.session = new Soup.Session({timeout: 8, max_conns: 1, max_conns_per_host: 1});
        this.coverEpoch = 0;
        this.coverCancel = null;
        this.nameSignal = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                if (params.deep_unpack()[0].startsWith('org.mpris.MediaPlayer2.spotify'))
                    this.discover();
            });
        this.discover();
    }

    empty() {
        return {connected: false, title: 'Spotify', artist: 'Nada en reproducción',
            album: '', playing: false, length: 0, position: 0, at: NOW(), track: '/',
            canPlay: false, canPause: false, canSeek: false, canNext: false,
            canPrevious: false, art: '', cover: null};
    }

    discover() {
        const epoch = ++this.epoch;
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, 2500, this.cancel, (bus, result) => {
                try {
                    const [names] = bus.call_finish(result).deep_unpack();
                    if (!this.life.alive || epoch !== this.epoch)
                        return;
                    const name = choosePlayer(names);
                    this.detach();
                    if (!name) {
                        this.state = this.empty();
                        this.changed(this.state);
                        return;
                    }
                    Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
                        Gio.DBusProxyFlags.NONE, null, name, PATH, IFACE,
                        this.cancel, (_source, ready) => {
                            try {
                                const proxy = Gio.DBusProxy.new_for_bus_finish(ready);
                                if (!this.life.alive || epoch !== this.epoch)
                                    return;
                                this.proxy = proxy;
                                this.proxySignals.push(proxy.connect('g-properties-changed', () => this.sync()));
                                this.proxySignals.push(proxy.connect('g-signal', (_p, _s, signal, params) => {
                                    if (signal === 'Seeked') {
                                        this.state.position = params.deep_unpack()[0];
                                        this.state.at = NOW();
                                        this.changed(this.state);
                                    }
                                }));
                                this.sync();
                                this.refreshPosition();
                            } catch (error) { this.report(error); }
                        });
                } catch (error) { this.report(error); }
            });
    }

    detach() {
        for (const id of this.proxySignals)
            this.proxy?.disconnect(id);
        this.proxySignals = [];
        this.proxy = null;
        this.coverEpoch++;
        this.coverCancel?.cancel();
    }

    get(key, fallback) {
        return this.proxy?.get_cached_property(key)?.deep_unpack() ?? fallback;
    }

    sync() {
        const old = this.state;
        const meta = this.get('Metadata', {});
        const value = (key, fallback) => meta[key]?.deep_unpack?.() ?? meta[key] ?? fallback;
        const track = value('mpris:trackid', '/');
        const art = value('mpris:artUrl', '');
        const album = value('xesam:album', '');
        this.state = {
            connected: Boolean(this.proxy?.g_name_owner),
            title: value('xesam:title', 'Spotify'),
            artist: value('xesam:artist', []).join(', ') || 'Spotify',
            album: album ? String(album) : '',
            playing: this.get('PlaybackStatus', 'Stopped') === 'Playing',
            length: value('mpris:length', 0), track, art,
            position: old.track === track ? this.position() : 0, at: NOW(),
            canPlay: this.get('CanControl', false) && this.get('CanPlay', false),
            canPause: this.get('CanControl', false) && this.get('CanPause', false),
            canSeek: this.get('CanControl', false) && this.get('CanSeek', false),
            canNext: this.get('CanControl', false) && this.get('CanGoNext', false),
            canPrevious: this.get('CanControl', false) && this.get('CanGoPrevious', false),
            cover: old.art === art ? old.cover : null,
        };
        this.changed(this.state);
        if (old.art !== art)
            this.loadCover(art);
        if (old.track !== track || old.playing !== this.state.playing)
            this.refreshPosition();
    }

    raise() {
        if (this.proxy) {
            Gio.DBus.session.call(this.proxy.g_name, PATH, 'org.mpris.MediaPlayer2',
                'Raise', null, null, Gio.DBusCallFlags.NONE, 2000, this.cancel, () => {});
        }
        try {
            const app = Shell.AppSystem.get_default().lookup_app('com.spotify.Client.desktop') ||
                        Shell.AppSystem.get_default().lookup_app('spotify.desktop');
            if (app)
                app.activate();
        } catch (_) {}
    }

    position() {
        return positionAt(this.state.position, this.state.at, this.state.playing,
            this.state.length, NOW());
    }

    refreshPosition() {
        if (!this.proxy)
            return;
        const proxy = this.proxy;
        const track = this.state.track;
        Gio.DBus.session.call(proxy.g_name, PATH, 'org.freedesktop.DBus.Properties',
            'Get', new GLib.Variant('(ss)', [IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000,
            this.cancel, (bus, result) => {
                try {
                    const reply = bus.call_finish(result);
                    if (!this.life.alive || this.proxy !== proxy || track !== this.state.track)
                        return;
                    this.state.position = reply.get_child_value(0).get_variant().get_int64();
                    this.state.at = NOW();
                    this.changed(this.state);
                } catch (error) { this.report(error); }
            });
    }

    command(method) {
        const key = {Previous: 'canPrevious', Next: 'canNext', PlayPause:
            this.state.playing ? 'canPause' : 'canPlay'}[method];
        if (!this.proxy || !this.state[key])
            return;
        this.call(method, null);
    }

    seek(fraction) {
        if (!this.state.canSeek || this.state.length <= 0 || this.state.track === '/')
            return;
        const position = Math.round(Math.max(0, Math.min(1, fraction)) * this.state.length);
        this.call('SetPosition', new GLib.Variant('(ox)', [this.state.track, position]));
    }

    call(method, args) {
        this.proxy.call(method, args, Gio.DBusCallFlags.NONE, 2500, this.cancel, (proxy, result) => {
            try {
                proxy.call_finish(result);
                if (this.life.alive)
                    this.refreshPosition();
            } catch (error) { this.report(error); }
        });
    }

    async loadCover(uri) {
        this.coverCancel?.cancel();
        const epoch = ++this.coverEpoch;
        this.coverCancel = new Gio.Cancellable();
        const cancel = this.coverCancel;
        if (!coverUriAllowed(uri))
            return;
        let stream;
        try {
            const message = Soup.Message.new('GET', uri);
            // Don't follow redirects to a different scheme or local resource.
            message.flags |= Soup.MessageFlags.NO_REDIRECT;
            stream = await this.session.send_async(message, GLib.PRIORITY_DEFAULT, cancel);
            if (!this.life.alive || epoch !== this.coverEpoch)
                return;
            if (message.status_code !== 200 || message.response_headers.get_content_length() > 2 * 1024 * 1024)
                return;
            const chunks = [];
            let total = 0;
            while (total <= 2 * 1024 * 1024) {
                const chunk = await stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancel);
                if (!chunk.get_size())
                    break;
                chunks.push(chunk.get_data());
                total += chunk.get_size();
            }
            if (total > 2 * 1024 * 1024 || !this.life.alive || epoch !== this.coverEpoch)
                return;
            const data = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
            const input = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data));
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                input, 192, 192, true, cancel);
            input.close(null);
            if (!this.life.alive || epoch !== this.coverEpoch)
                return;
            const [ok, thumbnail] = pixbuf.save_to_bufferv('png', [], []);
            if (!ok)
                return;
            this.state.cover = Gio.BytesIcon.new(GLib.Bytes.new(thumbnail));
            this.changed(this.state);
        } catch (_) {
            // Artwork is optional; the musical-note placeholder remains usable offline.
        } finally {
            if (stream)
                stream.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
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
        this.detach();
        Gio.DBus.session.signal_unsubscribe(this.nameSignal);
        this.session.abort();
    }
}
