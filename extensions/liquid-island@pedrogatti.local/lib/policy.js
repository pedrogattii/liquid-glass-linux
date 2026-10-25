// Pure rules shared by the shell and the inexpensive regression tests.
export function canPresent({hidden, dnd, enabled = true, banners = true, urgency = 1}) {
    return !hidden && enabled && urgency > 0 &&
        (urgency === 3 || (!dnd && banners));
}

export function positionAt(position, timestamp, playing, length, now) {
    const elapsed = playing ? Math.max(0, now - timestamp) : 0;
    return Math.max(0, Math.min(length || Infinity, position + elapsed));
}

export function choosePlayer(names, activeStates = {}) {
    const players = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
    const isPlaying = name => Boolean(activeStates?.[name]?.playing ?? (typeof activeStates?.[name] === 'boolean' ? activeStates[name] : false));
    return players.sort((a, b) => {
        const playA = isPlaying(a);
        const playB = isPlaying(b);
        if (playA !== playB) return playA ? -1 : 1;

        const spotA = a.includes('spotify');
        const spotB = b.includes('spotify');
        if (spotA !== spotB) return spotA ? -1 : 1;

        return a.localeCompare(b);
    })[0] ?? null;
}

export function extractDominantColor(pixbuf) {
    if (!pixbuf) return '#5ac8fa';
    try {
        const pixels = pixbuf.get_pixels?.();
        if (!pixels) return '#5ac8fa';
        const rowstride = pixbuf.get_rowstride();
        const channels = pixbuf.get_n_channels();
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        if (channels < 3) return '#5ac8fa';

        let totalR = 0, totalG = 0, totalB = 0;
        let count = 0;

        for (let y = 0; y < height; y += 8) {
            const rowOffset = y * rowstride;
            for (let x = 0; x < width; x += 8) {
                const offset = rowOffset + x * channels;
                if (channels >= 4 && pixels[offset + 3] < 128)
                    continue;

                const r = pixels[offset];
                const g = pixels[offset + 1];
                const b = pixels[offset + 2];

                if (r + g + b < 60)
                    continue;

                const max = Math.max(r, g, b);
                const min = Math.min(r, g, b);
                if (max - min < 25)
                    continue;

                totalR += r;
                totalG += g;
                totalB += b;
                count++;
            }
        }

        if (count === 0)
            return '#5ac8fa';

        let avgR = Math.round(totalR / count);
        let avgG = Math.round(totalG / count);
        let avgB = Math.round(totalB / count);

        const maxVal = Math.max(avgR, avgG, avgB);
        if (maxVal < 140 && maxVal > 0) {
            const factor = 140 / maxVal;
            avgR = Math.min(255, Math.round(avgR * factor));
            avgG = Math.min(255, Math.round(avgG * factor));
            avgB = Math.min(255, Math.round(avgB * factor));
        }

        const toHex = c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0');
        return `#${toHex(avgR)}${toHex(avgG)}${toHex(avgB)}`;
    } catch (_) {
        return '#5ac8fa';
    }
}

export function coverUriAllowed(uri) {
    return typeof uri === 'string' && /^(https?|file):\/\//i.test(uri);
}

export function plainText(value) {
    return String(value ?? '').replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .slice(0, 1200);
}
