// Run with node --experimental-vm-modules tests/gpu-service.mjs. No live GPU/session access.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const files = new Map([
    ['/sys/class/drm/card0/device/vendor', '0x10de'],
    ['/sys/class/drm/card0/device/uevent', 'PCI_SLOT_NAME=0000:01:00.0\n'],
    ['/sys/class/drm/card1/device/vendor', '0x1002'],
    ['/sys/class/drm/card1/device/uevent', 'PCI_SLOT_NAME=0000:05:00.0\n'],
    ['/sys/class/drm/card1/device/gpu_busy_percent', '27'],
    ['/sys/class/drm/card1/device/mem_info_vram_used', '1048576'],
    ['/sys/class/drm/card1/device/mem_info_vram_total', '2097152'],
    ['/sys/class/drm/card2/device/vendor', '0x8086'],
    ['/proc/stat', 'cpu  100 0 100 400 0 0 0 0\n'],
    ['/proc/meminfo', 'MemTotal: 8000 kB\nMemAvailable: 2000 kB\n'],
]);
let reads = [];
let enumerations = 0;
let closedEnumerators = 0;
let executable = true;
let holdProcess = false;
let successful = true;
const processes = [];
const completions = [];
const sources = new Map();
let serial = 0;
class Cancellable {
    constructor() { this.cancelled = false; }
    cancel() { this.cancelled = true; }
    is_cancelled() { return this.cancelled; }
}
const Gio = {Cancellable, FileQueryInfoFlags: {NONE: 0},
    SubprocessFlags: {STDOUT_PIPE: 1, STDERR_SILENCE: 2},
    File: {new_for_path(path) { return {
        load_contents_async(cancel, callback) {
            reads.push(path);
            queueMicrotask(() => callback(this, {cancel, path}));
        },
        load_contents_finish({cancel, path: requested}) {
            if (cancel.is_cancelled() || !files.has(requested)) throw new Error('Unavailable');
            return [true, new TextEncoder().encode(files.get(requested))];
        },
        enumerate_children_async(_attrs, _flags, _priority, cancel, callback) {
            enumerations++;
            let first = true;
            const enumerator = {
                next_files_async(_count, _prio, _cancel, next) {
                    const infos = first ? ['card0', 'card0-HDMI-A-1', 'card1', 'card2', 'renderD128']
                        .map(name => ({get_name: () => name})) : [];
                    first = false;
                    queueMicrotask(() => next(this, infos));
                },
                next_files_finish: result => result,
                close_async(_priority, _cancel, done) { closedEnumerators++; queueMicrotask(() => done(this, null)); },
                close_finish() {},
            };
            queueMicrotask(() => callback(this, {cancel, enumerator}));
        },
        enumerate_children_finish({cancel, enumerator}) {
            if (cancel.is_cancelled()) throw new Error('Cancelled');
            return enumerator;
        },
    }; }},
    Subprocess: {new(argv, flags) {
        assert.equal(argv[0], '/usr/bin/nvidia-smi');
        assert.equal(argv.length, 3);
        assert.equal(argv[1], '--query-gpu=pci.bus_id,name,utilization.gpu,memory.used,memory.total');
        assert.equal(argv[2], '--format=csv,noheader,nounits');
        assert.equal(flags, 3);
        const process = {killed: 0, force_exit() { this.killed++; },
            communicate_utf8_async(_input, cancel, callback) {
                const done = () => callback(this, {cancel});
                if (holdProcess) completions.push(done); else queueMicrotask(done);
            },
            communicate_utf8_finish({cancel}) {
                if (cancel.is_cancelled()) throw new Error('Cancelled');
                return [true, '00000000:01:00.0, NVIDIA RTX, 0, 200, 8192\n'];
            },
            get_successful: () => successful,
        };
        processes.push(process); return process;
    }},
};
const GLib = {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    FileTest: {IS_EXECUTABLE: 1}, file_test: () => executable,
    source_remove: id => sources.delete(id),
    timeout_add(_priority, ms, callback) { const id = ++serial; sources.set(id, {ms, callback}); return id; },
    timeout_add_seconds(_priority, seconds, callback) { const id = ++serial; sources.set(id, {ms: seconds * 1000, callback}); return id; },
};
const context = vm.createContext({TextDecoder, TextEncoder, console});
const modules = new Map();
const fakes = new Map([['gi://Gio', Gio], ['gi://GLib', GLib]]);
async function moduleFor(id) {
    if (modules.has(id)) return modules.get(id);
    const module = fakes.has(id) ? new vm.SyntheticModule(['default'], function () {
        this.setExport('default', fakes.get(id));
    }, {context}) : new vm.SourceTextModule(await readFile(new URL(id), 'utf8'), {context, identifier: id});
    modules.set(id, module);
    await module.link((specifier, parent) => moduleFor(specifier.startsWith('gi://') ? specifier : new URL(specifier, parent.identifier).href));
    return module;
}
const source = await moduleFor(new URL('../extensions/liquid-island@pedrogatti.local/lib/gpuTelemetry.js', import.meta.url).href);
await source.evaluate();
const {GpuTelemetry} = source.namespace;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const gpu = new GpuTelemetry();
await gpu.sample();
assert.equal(reads.length, 0);
assert.equal(enumerations, 0);
assert.equal(processes.length, 0, 'disabled GPU never probes hardware or spawns processes');
gpu.setEnabled(true);
const first = gpu.sample();
assert.equal(gpu.sample(), first, 'concurrent samples share a single query');
const state = await first;
assert.equal(state.available, true);
assert.equal(state.devices.length, 3, 'NVIDIA sysfs/CLI PCI IDs deduplicate; connector nodes are excluded');
assert.equal(state.devices.find(device => device.vendor === 'NVIDIA').memoryUsed, 200 * 1024 * 1024);
assert.equal(state.devices.find(device => device.vendor === 'AMD').utilization, 27);
assert.equal(state.devices.find(device => device.vendor === 'Intel').utilization, null);
assert.equal(processes.length, 1);
await settle();
assert.equal(closedEnumerators, enumerations);
assert.equal(sources.size, 0, 'completed subprocess removes its deadline');
gpu.setEnabled(false);
const readCount = reads.length;
await gpu.sample();
assert.equal(reads.length, readCount);
assert.equal(gpu.state.reason, 'disabled');

// Missing optional tool is skipped. Native sysfs GPU monitoring still succeeds.
executable = false;
gpu.setEnabled(true);
await gpu.sample();
assert.equal(processes.length, 1);
assert.equal(gpu.state.available, true);
gpu.setEnabled(false);
// A failing optional NVIDIA query is not retried every sampling tick.
executable = true; successful = false;
gpu.setEnabled(true);
await gpu.sample(); const processCount = processes.length;
await gpu.sample();
assert.equal(processes.length, processCount);
gpu.setEnabled(false); successful = true;

// Deadline cancels communication, terminates/reaps through Gio, and never publishes late data.
holdProcess = true; gpu.setEnabled(true);
const timeoutSample = gpu.sample();
await settle();
const timeout = [...sources.entries()].find(([, item]) => item.ms === 1800);
assert.ok(timeout);
sources.delete(timeout[0]); timeout[1].callback();
assert.equal(processes.at(-1).killed, 1);
for (const complete of completions.splice(0)) complete();
await timeoutSample;
assert.equal(sources.size, 0);
assert.equal(gpu.state.devices.find(device => device.vendor === 'NVIDIA').utilization, null,
    'timed-out NVIDIA reply cannot fabricate cached metrics');
const afterTimeout = processes.length;
await gpu.sample();
assert.equal(processes.length, afterTimeout, 'timed-out tool stays disabled until explicit re-enable');
gpu.setEnabled(false); gpu.setEnabled(true);
const late = gpu.sample();
await settle();
const lateProcess = processes.at(-1);
gpu.destroy();
assert.equal(lateProcess.killed, 1);
assert.equal(sources.size, 0);
for (const complete of completions.splice(0)) complete();
await late;
assert.equal(gpu.state.enabled, false);
assert.equal(gpu.state.devices.length, 0, 'late work cannot restore disabled GPU state');

// The existing CPU/RAM timer owns cadence; setGpuEnabled is safe under UI feedback.
holdProcess = false;
const telemetrySource = await moduleFor(new URL('../extensions/liquid-island@pedrogatti.local/lib/telemetry.js', import.meta.url).href);
await telemetrySource.evaluate();
const {Telemetry} = telemetrySource.namespace;
let telemetry;
let changes = 0;
telemetry = new Telemetry(() => {
    changes++;
    telemetry?.setGpuEnabled(telemetry.gpu.enabled);
});
await settle();
const beforeEnable = processes.length;
telemetry.setGpuEnabled(true);
await settle();
assert.equal(processes.length, beforeEnable + 1);
assert.equal(telemetry.state.gpu.available, true);
telemetry.setGpuEnabled(false);
const afterDisable = processes.length;
await telemetry.sample();
assert.equal(processes.length, afterDisable, 'CPU/RAM sampling cannot poll disabled GPU');
assert.ok(changes < 20, 'same-state UI feedback cannot recursively emit or spawn');
let releaseOldSnapshot;
telemetry.gpu.sample = () => new Promise(resolve => { releaseOldSnapshot = resolve; });
telemetry.setGpuEnabled(true);
telemetry.setGpuEnabled(false);
releaseOldSnapshot({enabled: true, available: true, devices: [], reason: 'ready'});
await settle();
assert.equal(telemetry.state.gpu.enabled, false, 'late enabled snapshot cannot override later UI disable');
telemetry.destroy();
assert.equal(sources.size, 0, 'destroy removes the shared CPU timer and all GPU deadlines');
console.log('GPU service: disabled gating, native metrics, deduplication, absent/failing tool, timeout and cleanup passed');
