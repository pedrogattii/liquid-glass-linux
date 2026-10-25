// Pure rules shared by the shell and the inexpensive regression tests.
export function canPresent({hidden, dnd, enabled = true, banners = true, urgency = 1}) {
    return !hidden && enabled && urgency > 0 &&
        (urgency === 3 || (!dnd && banners));
}

export function positionAt(position, timestamp, playing, length, now) {
    const elapsed = playing ? Math.max(0, now - timestamp) : 0;
    return Math.max(0, Math.min(length || Infinity, position + elapsed));
}

export function choosePlayer(names) {
    return names.filter(n => n.startsWith('org.mpris.MediaPlayer2.spotify'))
        .sort((a, b) => (a === 'org.mpris.MediaPlayer2.spotify' ? -1 :
            b === 'org.mpris.MediaPlayer2.spotify' ? 1 : a.localeCompare(b)))[0] ?? null;
}

export function coverUriAllowed(uri) {
    // No arbitrary filesystem reads from metadata supplied by another process.
    return typeof uri === 'string' && /^https:\/\//i.test(uri);
}

export function plainText(value) {
    return String(value ?? '').replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .slice(0, 1200);
}
