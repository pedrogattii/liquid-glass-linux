import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DRM_PATH = '/sys/class/drm';
const NVIDIA_PATH = '/usr/bin/nvidia-smi';
const NVIDIA_ARGS = [NVIDIA_PATH,
    '--query-gpu=pci.bus_id,name,utilization.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits'];
const NVIDIA_TIMEOUT_MS = 1800;
const MiB = 1024 * 1024;

export function gpuNumber(text, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof text !== 'string' || !/^\d+(?:\.\d+)?$/.test(text.trim()))
        return null;
    const value = Number(text.trim());
    return Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

export function gpuMemory(used, total, multiplier = 1) {
    let memoryUsed = gpuNumber(used);
    let memoryTotal = gpuNumber(total);
    memoryUsed = memoryUsed === null ? null : memoryUsed * multiplier;
    memoryTotal = memoryTotal === null ? null : memoryTotal * multiplier;
    if ((memoryUsed !== null && !Number.isSafeInteger(memoryUsed)) ||
        (memoryTotal !== null && !Number.isSafeInteger(memoryTotal)) ||
        (memoryUsed !== null && memoryTotal !== null && memoryUsed > memoryTotal))
        return {memoryUsed: null, memoryTotal: null};
    return {memoryUsed, memoryTotal};
}

export function gpuVendor(text) {
    return {'0x1002': 'AMD', '0x8086': 'Intel', '0x10de': 'NVIDIA'}[
        String(text ?? '').trim().toLowerCase()] ?? 'GPU';
}

function pciId(text) {
    const match = String(text ?? '').trim().match(/^([\da-f]{4,8}):([\da-f]{2}):([\da-f]{2})\.([0-7])$/i);
    return match ? `${parseInt(match[1], 16).toString(16).padStart(4, '0')}:${match[2]}:${match[3]}.${match[4]}`.toLowerCase() : null;
}

function csvFields(line) {
    const fields = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (quoted && line[i + 1] === '"') { value += '"'; i++; }
            else quoted = !quoted;
        } else if (char === ',' && !quoted) { fields.push(value.trim()); value = ''; }
        else value += char;
    }
    if (quoted)
        return [];
    fields.push(value.trim());
    return fields;
}

export function parseNvidiaGpu(text) {
    if (typeof text !== 'string' || text.length > 65536)
        return [];
    const devices = [];
    for (const line of text.trim().split('\n').slice(0, 32)) {
        const fields = csvFields(line);
        if (fields.length !== 5)
            continue;
        const [bus, name, busy, used, total] = fields;
        const id = pciId(bus);
        if (!id || !name || name.length > 256 || devices.some(device => device.id === id))
            continue;
        devices.push({id, name, vendor: 'NVIDIA', source: 'nvidia-smi',
            utilization: gpuNumber(busy, 100), ...gpuMemory(used, total, MiB)});
    }
    return devices;
}

export function sysfsGpu(card, readings) {
    const vendor = gpuVendor(readings.vendor);
    const slot = String(readings.uevent ?? '').match(/^PCI_SLOT_NAME=(.+)$/m)?.[1];
    const label = String(readings.product ?? '').trim().slice(0, 256);
    return {id: pciId(slot) ?? card, name: label || `${vendor} · ${card}`, vendor,
        source: 'sysfs', utilization: gpuNumber(readings.busy, 100),
        ...gpuMemory(readings.used, readings.total)};
}

export function gpuSnapshot(devices = [], enabled = true) {
    const available = devices.some(device => device.utilization !== null ||
        device.memoryUsed !== null || device.memoryTotal !== null);
    return {enabled, available, devices, reason: !enabled ? 'disabled' :
        available ? 'ready' : devices.length ? 'unsupported' : 'no-device'};
}

// No timer or process exists here until Telemetry requests an enabled sample.
export class GpuTelemetry {
    constructor() {
        this.enabled = false;
        this.alive = true;
        this.generation = 0;
        this.cancellable = null;
        this.process = null;
        this.processCancel = null;
        this.processTimeout = 0;
        this.nvidiaUsable = null;
        this.inFlight = null;
        this.state = gpuSnapshot([], false);
    }

    setEnabled(enabled) {
        enabled = Boolean(enabled) && this.alive;
        if (enabled === this.enabled)
            return;
        this.enabled = enabled;
        this.generation++;
        this.cancellable?.cancel();
        this.stopProcess();
        this.inFlight = null;
        this.cancellable = enabled ? new Gio.Cancellable() : null;
        this.nvidiaUsable = null;
        this.state = gpuSnapshot([], enabled);
    }

    stopProcess() {
        if (this.processTimeout) {
            GLib.source_remove(this.processTimeout);
            this.processTimeout = 0;
        }
        this.processCancel?.cancel();
        this.processCancel = null;
        if (this.process) {
            try { this.process.force_exit(); } catch (_) { /* already exited */ }
            this.process = null;
        }
    }

    current(generation) {
        return this.alive && this.enabled && generation === this.generation &&
            !this.cancellable?.is_cancelled();
    }

    read(path, cancellable) {
        return new Promise(resolve => {
            if (cancellable.is_cancelled()) { resolve(null); return; }
            Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
                try {
                    const [ok, contents] = file.load_contents_finish(result);
                    resolve(ok && contents.length <= 65536 ? new TextDecoder().decode(contents) : null);
                } catch (_) { resolve(null); }
            });
        });
    }

    async cards(cancellable) {
        let enumerator;
        try {
            enumerator = await new Promise((resolve, reject) => {
                Gio.File.new_for_path(DRM_PATH).enumerate_children_async('standard::name',
                    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (file, result) => {
                        try { resolve(file.enumerate_children_finish(result)); } catch (error) { reject(error); }
                    });
            });
            const names = [];
            let examined = 0;
            while (!cancellable.is_cancelled() && examined < 1024) {
                const infos = await new Promise((resolve, reject) => {
                    enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                        try { resolve(source.next_files_finish(result)); } catch (error) { reject(error); }
                    });
                });
                if (!infos.length)
                    break;
                examined += infos.length;
                for (const info of infos) {
                    if (/^card\d+$/.test(info.get_name()))
                        names.push(info.get_name());
                }
            }
            return names.sort().slice(0, 32);
        } catch (_) { return []; }
        finally {
            if (enumerator) {
                enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try { source.close_finish(result); } catch (_) { /* cancelled enumeration */ }
                });
            }
        }
    }

    async readSysfs(cancellable) {
        const cards = await this.cards(cancellable);
        return Promise.all(cards.map(async card => {
            const base = `${DRM_PATH}/${card}/device`;
            const files = {vendor: 'vendor', uevent: 'uevent', product: 'product_name',
                busy: 'gpu_busy_percent', used: 'mem_info_vram_used', total: 'mem_info_vram_total'};
            const values = await Promise.all(Object.entries(files).map(async ([key, file]) =>
                [key, await this.read(`${base}/${file}`, cancellable)]));
            return sysfsGpu(card, Object.fromEntries(values));
        }));
    }

    readNvidia(generation) {
        if (this.nvidiaUsable === null)
            this.nvidiaUsable = GLib.file_test(NVIDIA_PATH, GLib.FileTest.IS_EXECUTABLE);
        if (!this.nvidiaUsable || !this.current(generation))
            return Promise.resolve([]);
        return new Promise(resolve => {
            let process;
            const cancellable = new Gio.Cancellable();
            try {
                process = Gio.Subprocess.new(NVIDIA_ARGS,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                this.process = process;
                this.processCancel = cancellable;
                this.processTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NVIDIA_TIMEOUT_MS, () => {
                    if (this.process === process) {
                        this.processTimeout = 0;
                        this.nvidiaUsable = false;
                        cancellable.cancel();
                        try { process.force_exit(); } catch (_) { /* already exited */ }
                    }
                    return GLib.SOURCE_REMOVE;
                });
                process.communicate_utf8_async(null, cancellable, (source, result) => {
                    let devices = [];
                    try {
                        const [ok, stdout] = source.communicate_utf8_finish(result);
                        if (ok && source.get_successful())
                            devices = parseNvidiaGpu(stdout);
                        else if (this.current(generation))
                            this.nvidiaUsable = false;
                    } catch (_) {
                        if (this.current(generation))
                            this.nvidiaUsable = false;
                    }
                    if (this.process === process) {
                        if (this.processTimeout)
                            GLib.source_remove(this.processTimeout);
                        this.processTimeout = 0;
                        this.process = null;
                        this.processCancel = null;
                    }
                    resolve(this.current(generation) ? devices : []);
                });
            } catch (_) {
                if (this.current(generation))
                    this.nvidiaUsable = false;
                this.stopProcess();
                resolve([]);
            }
        });
    }

    sample() {
        if (!this.enabled || !this.alive)
            return Promise.resolve(this.state);
        if (this.inFlight)
            return this.inFlight;
        const generation = this.generation;
        const cancellable = this.cancellable;
        const pending = (async () => {
            const [sysfs, nvidia] = await Promise.all([
                this.readSysfs(cancellable), this.readNvidia(generation),
            ]);
            if (this.current(generation)) {
                const ids = new Set(nvidia.map(device => device.id));
                const devices = [...sysfs.filter(device => !ids.has(device.id)), ...nvidia]
                    .sort((a, b) => a.id.localeCompare(b.id));
                this.state = gpuSnapshot(devices);
            }
            return this.state;
        })().finally(() => {
            if (this.inFlight === pending)
                this.inFlight = null;
        });
        this.inFlight = pending;
        return pending;
    }

    destroy() {
        this.setEnabled(false);
        this.alive = false;
    }
}
