import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Lifetime} from './lifecycle.js';

const THERMAL_PATHS = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/class/thermal/thermal_zone1/temp',
    '/sys/class/hwmon/hwmon0/temp1_input',
];

export class Telemetry {
    constructor(onChange) {
        this.onChange = onChange;
        this.life = new Lifetime();
        this.cancellable = new Gio.Cancellable();
        this.state = {cpu: 0, ram: 0, temp: null};
        this._prevTotal = 0;
        this._prevIdle = 0;
        this._sampling = false;
        this._activeThermalPath = null;

        this.sample();
        this.life.timeoutSeconds(3, () => {
            this.sample();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _loadFileAsync(path) {
        return new Promise(resolve => {
            if (this.cancellable.is_cancelled() || !this.life.alive) {
                resolve(null);
                return;
            }
            const file = Gio.File.new_for_path(path);
            file.load_contents_async(this.cancellable, (f, res) => {
                try {
                    const [ok, contents] = f.load_contents_finish(res);
                    if (ok && contents) {
                        resolve(new TextDecoder().decode(contents));
                        return;
                    }
                } catch (_) {
                    // File not available or cancelled
                }
                resolve(null);
            });
        });
    }

    async sample() {
        if (!this.life.alive || this.cancellable.is_cancelled() || this._sampling)
            return;
        this._sampling = true;

        try {
            const [statText, memText] = await Promise.all([
                this._loadFileAsync('/proc/stat'),
                this._loadFileAsync('/proc/meminfo'),
            ]);

            if (!this.life.alive || this.cancellable.is_cancelled())
                return;

            if (statText) {
                const firstLine = statText.split('\n')[0];
                const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
                if (parts.length >= 4) {
                    const idle = (parts[3] || 0) + (parts[4] || 0);
                    const total = parts.slice(0, 8).reduce((acc, n) => acc + n, 0);
                    if (this._prevTotal > 0 && total > this._prevTotal) {
                        const totalDelta = total - this._prevTotal;
                        const idleDelta = idle - this._prevIdle;
                        if (totalDelta > 0) {
                            const percent = Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
                            this.state.cpu = Math.max(0, Math.min(100, percent));
                        }
                    }
                    this._prevTotal = total;
                    this._prevIdle = idle;
                }
            }

            if (memText) {
                let total = 0;
                let available = 0;
                for (const line of memText.split('\n')) {
                    if (line.startsWith('MemTotal:'))
                        total = parseInt(line.replace(/[^0-9]/g, ''), 10);
                    else if (line.startsWith('MemAvailable:'))
                        available = parseInt(line.replace(/[^0-9]/g, ''), 10);
                }
                if (total > 0) {
                    const used = total - available;
                    this.state.ram = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
                }
            }

            let temp = null;
            const thermalCandidates = this._activeThermalPath
                ? [this._activeThermalPath, ...THERMAL_PATHS.filter(p => p !== this._activeThermalPath)]
                : THERMAL_PATHS;

            for (const path of thermalCandidates) {
                const text = await this._loadFileAsync(path);
                if (!this.life.alive || this.cancellable.is_cancelled())
                    return;
                if (text) {
                    const val = parseInt(text.trim(), 10);
                    if (!isNaN(val) && val > 0) {
                        temp = Math.round(val / 1000);
                        this._activeThermalPath = path;
                        break;
                    }
                }
            }
            this.state.temp = temp;

            if (this.life.alive && !this.cancellable.is_cancelled())
                this.onChange?.(this.state);
        } catch (error) {
            console.debug(`Liquid Island telemetry: ${error.message}`);
        } finally {
            this._sampling = false;
        }
    }

    destroy() {
        this.cancellable.cancel();
        this.life.destroy();
        this.onChange = null;
    }
}
