import GLib from 'gi://GLib';

// Explicit ownership keeps shell reloads and late async completions harmless.
export class Lifetime {
    constructor() {
        this.alive = true;
        this.signals = [];
        this.sources = new Set();
    }

    connect(object, signal, callback) {
        const id = object.connect(signal, (...args) => {
            if (this.alive)
                return callback(...args);
            return undefined;
        });
        this.signals.push([object, id]);
        return id;
    }

    after(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this.sources.delete(id);
            if (this.alive)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this.sources.add(id);
        return id;
    }

    cancel(id) {
        if (this.sources.delete(id))
            GLib.source_remove(id);
    }

    destroy() {
        this.alive = false;
        for (const id of this.sources)
            GLib.source_remove(id);
        this.sources.clear();
        for (const [object, id] of this.signals.reverse()) {
            try { object.disconnect(id); } catch (_) { /* disposed source */ }
        }
        this.signals = [];
    }
}
