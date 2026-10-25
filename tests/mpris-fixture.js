// Only run under the private compositor launcher; never exports on the user's bus.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const runtime = GLib.getenv('XDG_RUNTIME_DIR') ?? '';
const base = runtime.replace(/\/runtime$/, '');
if (GLib.getenv('LIQUID_ISOLATED_TEST') !== '1' ||
    !/^\/tmp\/liquid-shell-test\.[A-Za-z0-9]+\/runtime$/.test(runtime) ||
    ['CONFIG', 'DATA', 'CACHE', 'STATE'].some(kind =>
        GLib.getenv(`XDG_${kind}_HOME`) !== `${base}/${kind.toLowerCase()}`) ||
    GLib.getenv('GSETTINGS_BACKEND') !== 'keyfile')
    throw new Error('MPRIS fixture requires the isolated /tmp/liquid-shell-test.* launcher');

const NAME = 'org.mpris.MediaPlayer2.liquid_test';
const PATH = '/org/mpris/MediaPlayer2';
const TRACK = '/org/mpris/MediaPlayer2/track/integration';
const ROOT_XML = `<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
  <property name="SupportedUriSchemes" type="as" access="read"/>
  <property name="SupportedMimeTypes" type="as" access="read"/>
</interface></node>`;
const PLAYER_XML = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="Play"/><method name="Pause"/><method name="PlayPause"/>
  <method name="Stop"/><method name="Previous"/><method name="Next"/>
  <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
  <method name="SetPosition"><arg name="TrackId" type="o" direction="in"/><arg name="Position" type="x" direction="in"/></method>
  <method name="OpenUri"><arg name="Uri" type="s" direction="in"/></method>
  <signal name="Seeked"><arg name="Position" type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="LoopStatus" type="s" access="readwrite"/>
  <property name="Rate" type="d" access="readwrite"/>
  <property name="Shuffle" type="b" access="readwrite"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Volume" type="d" access="readwrite"/>
  <property name="Position" type="x" access="read"/>
  <property name="MinimumRate" type="d" access="read"/>
  <property name="MaximumRate" type="d" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanControl" type="b" access="read"/>
</interface></node>`;

const loop = new GLib.MainLoop(null, false);
let owner = 0;
let quitting = false;
let rootExport;
let playerExport;
class Player {
    constructor() {
        this.status = 'Paused';
        this.position = 30000000;
        this.at = GLib.get_monotonic_time();
        this.trackNumber = 1;
        this.LoopStatus = 'None';
        this.Rate = 1;
        this.Shuffle = false;
        this.Volume = 0.5;
    }
    get PlaybackStatus() { return this.status; }
    get Metadata() {
        return {
            'mpris:trackid': new GLib.Variant('o', TRACK),
            'mpris:length': new GLib.Variant('x', 180000000),
            'xesam:title': new GLib.Variant('s', this.trackNumber === 1 ? 'Paused integration track' : `Integration track ${this.trackNumber}`),
            'xesam:artist': new GLib.Variant('as', ['Liquid fixture']),
            'xesam:album': new GLib.Variant('s', 'Private Shell test'),
        };
    }
    get Position() {
        return Math.min(180000000, this.position + (this.status === 'Playing' ? GLib.get_monotonic_time() - this.at : 0));
    }
    get MinimumRate() { return 1; }
    get MaximumRate() { return 1; }
    get CanGoNext() { return true; }
    get CanGoPrevious() { return true; }
    get CanPlay() { return true; }
    get CanPause() { return true; }
    get CanSeek() { return true; }
    get CanControl() { return true; }
    setStatus(status) {
        this.position = this.Position;
        this.at = GLib.get_monotonic_time();
        this.status = status;
        playerExport.emit_property_changed('PlaybackStatus', new GLib.Variant('s', status));
    }
    Play() { this.setStatus('Playing'); }
    Pause() { this.setStatus('Paused'); }
    PlayPause() { this.setStatus(this.status === 'Playing' ? 'Paused' : 'Playing'); }
    Stop() { this.setStatus('Stopped'); }
    Next() { this.trackNumber++; this.trackChanged(); }
    Previous() { this.trackNumber = Math.max(1, this.trackNumber - 1); this.trackChanged(); }
    trackChanged() {
        this.setPosition(0);
        playerExport.emit_property_changed('Metadata', new GLib.Variant('a{sv}', this.Metadata));
    }
    setPosition(value) {
        this.position = Math.max(0, Math.min(180000000, Number(value)));
        this.at = GLib.get_monotonic_time();
        playerExport.emit_signal('Seeked', new GLib.Variant('(x)', [this.position]));
    }
    Seek(offset) { this.setPosition(this.Position + Number(offset)); }
    SetPosition(track, position) { if (track === TRACK) this.setPosition(position); }
    OpenUri() {} // Deliberately never launches or opens anything.
}
const root = {
    CanQuit: true, CanRaise: true, HasTrackList: false,
    Identity: 'Liquid Test Player', DesktopEntry: 'liquid-test',
    SupportedUriSchemes: [], SupportedMimeTypes: [],
    Raise() {},
    Quit() {
        quitting = true;
        // Let the D-Bus method reply leave before closing the fixture connection.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    },
};
owner = Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE,
    connection => {
        rootExport = Gio.DBusExportedObject.wrapJSObject(ROOT_XML, root);
        playerExport = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, new Player());
        rootExport.export(connection, PATH);
        playerExport.export(connection, PATH);
    },
    () => print(`${NAME}: ready (Paused)`),
    () => { if (!quitting) printerr(`${NAME}: lost bus name`); loop.quit(); });
try { loop.run(); }
finally {
    rootExport?.unexport();
    playerExport?.unexport();
    if (owner) Gio.bus_unown_name(owner);
}
