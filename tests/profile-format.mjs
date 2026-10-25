import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {validateProfileTypes, MAX_PROFILE_STRING_BYTES} = await import(
    `data:text/javascript;base64,${Buffer.from(await readFile(new URL(
        '../extensions/liquid-island@pedrogatti.local/lib/profileFormat.js', import.meta.url))).toString('base64')}`);
const descriptors = {enabled: {type: 'b'}, notes: {type: 's'}, count: {type: 'i'},
    opacity: {type: 'd'}, order: {type: 'as'}, 'widget-tasks': {type: 's'}};
const profile = settings => ({format: 'liquid-glass', version: 1, settings});
const tasks = '[{"text":"Keep café text and \\n escapes intact","done":false}]';
const valid = profile({enabled: false, notes: 'café 🎵', count: -2147483648,
    opacity: 0.45, order: ['music', 'calendar'], 'widget-tasks': tasks});
const snapshot = JSON.stringify(valid);
assert.deepEqual(validateProfileTypes(valid, descriptors), Object.entries(valid.settings));
assert.equal(JSON.stringify(valid), snapshot, 'validation never changes the input');
assert.equal(validateProfileTypes(valid, descriptors).find(([key]) => key === 'widget-tasks')[1], tasks,
    'embedded task JSON is preserved verbatim');
const result = validateProfileTypes(valid, descriptors);
result.find(([key]) => key === 'order')[1].push('extra');
assert.deepEqual(valid.settings.order, ['music', 'calendar'], 'returned arrays do not alias input arrays');
assert.deepEqual(validateProfileTypes(profile({}), descriptors), [], 'partial profiles may be empty');
assert.deepEqual(validateProfileTypes(profile({count: 2147483647}), descriptors), [['count', 2147483647]]);

for (const settings of [
    {enabled: 'false'}, {enabled: 0}, {enabled: null},
    {notes: 42}, {notes: null},
    {count: 1.8}, {count: '1'}, {count: NaN}, {count: Infinity},
    {count: 2147483648}, {count: -2147483649},
    {opacity: '0.3'}, {opacity: null}, {opacity: Infinity}, {opacity: NaN},
    {order: 'music'}, {order: ['music', 2]}, {order: new Array(1)},
    {order: Array(1001).fill('music')}, {unknown: true},
])
    assert.throws(() => validateProfileTypes(profile(settings), descriptors), undefined,
        `reject malformed values: ${JSON.stringify(settings)}`);

for (const malformed of [null, [], 'json', {}, {format: 'liquid-glass', version: 1},
    {...profile({}), format: 'other'}, {...profile({}), version: 2},
    {...profile({}), version: '1'}, {...profile({}), extra: true},
    profile(null), profile([]), profile('text'), profile(new Date()),
])
    assert.throws(() => validateProfileTypes(malformed, descriptors));
assert.throws(() => validateProfileTypes(profile({enabled: true}), {enabled: {type: 'u'}}),
    /Tipo de ajuste no compatible/);
assert.throws(() => validateProfileTypes(profile({toString: 'intruder'}), descriptors), /Ajuste desconocido/);
assert.throws(() => validateProfileTypes(profile(JSON.parse('{"__proto__":true}')), descriptors), /Ajuste desconocido/);
const inherited = Object.create({enabled: {type: 'b'}});
assert.throws(() => validateProfileTypes(profile({enabled: true}), inherited));

const exactLimit = 'x'.repeat(MAX_PROFILE_STRING_BYTES);
assert.equal(validateProfileTypes(profile({notes: exactLimit}), descriptors)[0][1], exactLimit);
assert.throws(() => validateProfileTypes(profile({notes: `${exactLimit}x`}), descriptors));
assert.throws(() => validateProfileTypes(profile({notes: '🎵'.repeat(MAX_PROFILE_STRING_BYTES / 4 + 1)}), descriptors),
    undefined, 'string limit counts UTF-8 bytes');
assert.throws(() => validateProfileTypes(profile({order: [`${exactLimit}x`]}), descriptors));
assert.equal(validateProfileTypes(profile({order: Array(1000).fill('music')}), descriptors)[0][1].length, 1000);
const frozen = Object.freeze(profile(Object.freeze({enabled: true, count: 1.8})));
assert.throws(() => validateProfileTypes(frozen, descriptors));
assert.deepEqual(frozen.settings, {enabled: true, count: 1.8},
    'an error after a valid entry cannot partly mutate the input');
console.log('profile format: exact types, format, bounds, unknown keys and atomic validation passed');
