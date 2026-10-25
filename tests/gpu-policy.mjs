// Run with node --experimental-vm-modules tests/gpu-policy.mjs (no hardware access).
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context = vm.createContext({TextEncoder, TextDecoder});
const module = new vm.SourceTextModule(await readFile(new URL(
    '../extensions/liquid-island@pedrogatti.local/lib/gpuTelemetry.js', import.meta.url), 'utf8'), {context});
await module.link(() => new vm.SyntheticModule(['default'], function () {
    this.setExport('default', {});
}, {context}));
await module.evaluate();
const {gpuNumber, gpuMemory, gpuVendor, parseNvidiaGpu, sysfsGpu, gpuSnapshot} = module.namespace;
const plain = value => JSON.parse(JSON.stringify(value));
assert.equal(gpuNumber('0', 100), 0, 'observed zero remains valid');
assert.equal(gpuNumber(' 99.5\n', 100), 99.5);
for (const value of [null, undefined, 1, '', 'N/A', '[Not Supported]', '-1', '101', '15%', '3oops', 'Infinity', 'NaN', '1e2'])
    assert.equal(gpuNumber(value, 100), null, `reject malformed busy reading ${String(value)}`);
assert.equal(gpuNumber('9007199254740992'), null);
assert.deepEqual(plain(gpuMemory('1024', '2048')), {memoryUsed: 1024, memoryTotal: 2048});
assert.deepEqual(plain(gpuMemory('2048', '1024')), {memoryUsed: null, memoryTotal: null});
assert.deepEqual(plain(gpuMemory('N/A', '2048')), {memoryUsed: null, memoryTotal: 2048});
assert.deepEqual(plain(gpuMemory('1.3', '2.6')), {memoryUsed: null, memoryTotal: null});
assert.equal(gpuVendor('0x8086\n'), 'Intel');
assert.equal(gpuVendor('0x1002'), 'AMD');
assert.equal(gpuVendor('0x10de'), 'NVIDIA');
assert.equal(gpuVendor(null), 'GPU');
const devices = plain(parseNvidiaGpu('00000000:01:00.0, NVIDIA RTX 4090, 0, 128, 24564\n00000000:02:00.0, "GPU, test", N/A, N/A, 8192\n'));
assert.equal(devices.length, 2);
assert.equal(devices[0].id, '0000:01:00.0');
assert.equal(devices[0].utilization, 0);
assert.equal(devices[0].memoryUsed, 128 * 1024 * 1024);
assert.equal(devices[1].name, 'GPU, test');
assert.equal(devices[1].utilization, null);
assert.equal(devices[1].memoryUsed, null);
assert.equal(devices[1].memoryTotal, 8192 * 1024 * 1024);
for (const bad of ['', 'No devices found', 'bad id,GPU,10,1,2', '0000:01:00.0,"unterminated,3,1,2', 'x'.repeat(65537)])
    assert.equal(parseNvidiaGpu(bad).length, 0);
assert.equal(parseNvidiaGpu('0000:01:00.0,GPU,10,1,2\n0000:01:00.0,GPU,10,1,2').length, 1);
const amd = plain(sysfsGpu('card1', {vendor: '0x1002', uevent: 'PCI_SLOT_NAME=0000:05:00.0\n',
    busy: '23\n', used: '1048576', total: '2097152'}));
assert.equal(amd.id, '0000:05:00.0');
assert.equal(amd.name, 'AMD · card1');
assert.equal(amd.utilization, 23);
const unsupported = sysfsGpu('card2', {vendor: '0x8086'});
assert.equal(unsupported.name, 'Intel · card2');
assert.equal(unsupported.utilization, null, 'unsupported Intel metric is not fabricated');
assert.equal(gpuSnapshot([unsupported]).available, false);
assert.equal(gpuSnapshot([unsupported]).reason, 'unsupported');
assert.equal(gpuSnapshot(devices).available, true);
assert.equal(gpuSnapshot([], false).reason, 'disabled');
console.log('GPU policy: real zero, invalid/unsupported readings, VRAM bounds, vendor and NVIDIA CSV passed');
