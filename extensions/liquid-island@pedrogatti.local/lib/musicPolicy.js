// Pure media rules: usable by both Shell surfaces and regression tests.
export const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
export const DEFAULT_ACCENT = '#5ac8fa';
export const MAX_COVER_BYTES = 2 * 1024 * 1024;

export function desktopId(entry = '') {
    return entry ? `${String(entry).replace(/\.desktop$/, '')}.desktop` : '';
}

export function sameDesktopApp(left, right) {
    const canonical = entry => desktopId(entry).replace(/^(com\.spotify\.Client)\.desktop$/i, 'spotify.desktop');
    return Boolean(left && right) && canonical(left) === canonical(right);
}

export function nativeMusicApp(id = '', categories = '') {
    const values = new Set(String(categories).split(';'));
    if (values.has('WebBrowser'))
        return false;
    return /^(spotify|com\.spotify\.Client)\.desktop$/i.test(id) ||
        values.has('Music') || (values.has('Audio') && values.has('Player'));
}

export function playerPresent({connected = false, native = false,
    appRunning = false, ownerAlive = false}) {
    return connected || (native && (appRunning || ownerAlive));
}

// Stable display ordering is independent of selection and playback transitions.
export function orderPlayers(players) {
    return [...players].sort((a, b) => a.name.localeCompare(b.name));
}

export function selectPlayerName(players, manual = null, current = null) {
    const available = orderPlayers(players.filter(player => player.present));
    const selected = manual && (available.find(player => player.name === manual.name) ??
        (manual.desktopEntry && available.find(player =>
            sameDesktopApp(player.desktopEntry, manual.desktopEntry))));
    if (selected)
        return selected.name;
    const playing = available.filter(player => player.playing);
    const candidates = playing.length ? playing : available.filter(player => player.connected);
    const pool = candidates.length ? candidates : available;
    return pool.find(player => player.name === current)?.name ?? pool[0]?.name ?? null;
}

export function mediaMetadata(meta, identity = 'Reproductor multimedia') {
    const value = (key, fallback) => meta?.[key]?.deep_unpack?.() ?? meta?.[key] ?? fallback;
    const artists = value('xesam:artist', []);
    const length = Number(value('mpris:length', 0));
    const track = value('mpris:trackid', '/');
    return {
        title: String(value('xesam:title', '') || 'Sin título'),
        artist: (Array.isArray(artists) ? artists.join(', ') : String(artists)) || identity,
        album: String(value('xesam:album', '') || ''),
        length: Number.isFinite(length) ? Math.max(0, length) : 0,
        track: typeof track === 'string' && /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(track) ? track : '/',
        art: String(value('mpris:artUrl', '') || ''),
    };
}

export function mediaCapabilities(get, connected) {
    const control = connected && Boolean(get('CanControl', false));
    return {
        canPlay: control && Boolean(get('CanPlay', false)),
        canPause: control && Boolean(get('CanPause', false)),
        canSeek: control && Boolean(get('CanSeek', false)),
        canNext: control && Boolean(get('CanGoNext', false)),
        canPrevious: control && Boolean(get('CanGoPrevious', false)),
    };
}

export function artworkUriAllowed(uri) {
    if (typeof uri !== 'string' || uri.length > 8192)
        return false;
    return /^https:\/\/[^\s/]+\/[^\s]*$/i.test(uri) || /^file:\/\/\/[^\0\r\n]+$/i.test(uri);
}

export function localArtworkAllowed({regular, size, contentType}) {
    return regular && Number.isFinite(size) && size > 0 && size <= MAX_COVER_BYTES &&
        /^image\/(png|jpeg|webp|gif|bmp|x-bmp|x-portable-pixmap|x-icon)$/.test(contentType);
}
