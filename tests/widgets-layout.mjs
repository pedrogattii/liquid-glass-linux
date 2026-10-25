import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const source = await readFile(new URL('../extensions/liquid-island@pedrogatti.local/lib/widgetLayout.js', import.meta.url), 'utf8');
const {WIDGET_TYPES, parseWidgetLayout, parseLayout, clampWidget, resolveWidget,
    parseWidgetTasks, timerRemaining} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const monitors = [
    {connector: 'DP-2', x: -1920, y: 0, width: 1920, height: 1080, scale: 1},
    {connector: 'eDP-1', x: 0, y: 0, width: 1280, height: 800, scale: 2, primary: true},
];

test('strict imports reject malformed layouts; runtime parsing recovers safely', () => {
    for (const value of ['no json', '{}', 'null', '{"version":2,"widgets":{}}',
        '{"version":1,"widgets":[]}', '{"version":1,"widgets":{"__proto__":{}}}', '{"version":1,"widgets":{"unknown":{}}}',
        '{"version":1,"widgets":{"music":{"monitor":"DP-2","x":0,"y":0,"width":-3,"height":200}}}']) {
        assert.throws(() => parseLayout(value));
        assert.equal(parseWidgetLayout(value).version, 1);
    }
    assert.deepEqual(parseLayout('{"version":1,"widgets":{}}'), {version: 1, widgets: {}});
});

test('connector identity survives monitor ordering and changed resolution', () => {
    const saved = {monitor: 'DP-2', x: 1700, y: 900, width: 340, height: 230};
    const resolved = resolveWidget('music', saved, [...monitors].reverse());
    assert.equal(resolved.monitor.connector, 'DP-2');
    assert.deepEqual(resolved.rect, {...saved, x: 1580, y: 850});
    assert.equal(saved.x, 1700);
});

test('unplugged displays recover visibly on primary without overwriting saved connector', () => {
    const saved = {monitor: 'HDMI-A-1', x: -900, y: 8000, width: 4000, height: 3000};
    const resolved = resolveWidget('music', saved, monitors);
    assert.equal(resolved.monitor.connector, 'eDP-1');
    assert.deepEqual(resolved.rect, {monitor: 'eDP-1', x: 0, y: 0, width: 1280, height: 800});
    assert.equal(saved.monitor, 'HDMI-A-1');
    assert.equal(resolveWidget('music', saved, []), null);
});

test('clamp and grid snapping keep bounds visible even on very small monitors', () => {
    const tiny = {connector: 'tiny', width: 80, height: 60};
    assert.deepEqual(clampWidget('music', {x: 200, y: -20, width: 1000, height: 900}, tiny, true),
        {monitor: 'tiny', x: 0, y: 0, width: 80, height: 60});
    const rect = clampWidget('notes', {x: 25, y: 31, width: 307, height: 251}, monitors[0], true);
    assert.deepEqual(rect, {monitor: 'DP-2', x: 24, y: 36, width: 312, height: 252});
});

test('all widget default layouts are usable and imports canonicalize bounds', () => {
    for (const type of Object.keys(WIDGET_TYPES)) {
        const rect = resolveWidget(type, null, monitors, 0).rect;
        assert.ok(rect.width > 0 && rect.height > 0);
        assert.ok(rect.x + rect.width <= monitors[1].width);
        assert.ok(rect.y + rect.height <= monitors[1].height);
    }
    const value = parseLayout(JSON.stringify({version: 1, widgets: {clock: {
        monitor: 'DP-2', x: 9999999, y: -9999999, width: 2, height: 9999999,
    }}}));
    assert.equal(value.widgets.clock.width, WIDGET_TYPES.clock.minWidth);
    assert.equal(value.widgets.clock.height, 4000);
});

test('tasks recover from corrupt data and bound persisted user input', () => {
    assert.deepEqual(parseWidgetTasks('{broken'), []);
    assert.deepEqual(parseWidgetTasks('{}'), []);
    assert.deepEqual(parseWidgetTasks('[null,{"text":"Buy milk","done":true},{"text":5}]'),
        [{id: '0', text: 'Buy milk', done: true}]);
    assert.equal(parseWidgetTasks(JSON.stringify(Array.from({length: 150}, () => ({text: 'a'.repeat(2000)})))).length, 100);
});

test('timer derives remaining time from monotonic deadline across hidden intervals', () => {
    assert.equal(timerRemaining(null, 500000000, 300), 300);
    assert.equal(timerRemaining(60000000, 1000000, 0), 59);
    assert.equal(timerRemaining(60000000, 59999999, 0), 1);
    assert.equal(timerRemaining(60000000, 70000000, 0), 0);
});
