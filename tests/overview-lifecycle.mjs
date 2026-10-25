import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise lifecycle methods without loading GI or touching the running Shell.
const main = {
    layoutManager: {primaryMonitor: {x: 0, y: 0, width: 1920, height: 1080}},
    panel: {height: 32, get_transformed_position: () => [0, 0]},
};
const context = vm.createContext({
    Main: main,
    St: {ThemeContext: {get_for_stage: () => ({scale_factor: 1})}},
    Clutter: {AnimationMode: {EASE_IN_CUBIC: 1, EASE_OUT_CUBIC: 2}},
    global: {stage: {}},
    plainText: value => String(value ?? ''),
});
for (const [file, name] of [['island.js', 'Island'], ['backdrop.js', 'Backdrop']]) {
    const source = readFileSync(new URL(`../extensions/liquid-island@pedrogatti.local/lib/${file}`, import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(`export class ${name}`, `class ${name}`);
    vm.runInContext(`${source}\nglobalThis.${name} = ${name};`, context);
}
const {Island, Backdrop} = context;
function actor() {
    return {
        visible: true, transitions: [], removed: [], classes: new Set(),
        hide() { this.visible = false; },
        show() { this.visible = true; },
        destroy_all_children() { this.childrenCleared = true; },
        remove_all_transitions() { this.transitions = []; },
        remove_transition(name) { this.removed.push(name); },
        add_style_class_name(name) { this.classes.add(name); },
        remove_style_class_name(name) { this.classes.delete(name); },
        add_style_pseudo_class() {}, remove_style_pseudo_class() {}, set_style() {},
        ease(options) { this.transitions.push(options); },
    };
}
function fixture() {
    const island = Object.create(Island.prototype);
    Object.assign(island, {
        life: {alive: true, cancel() {}},
        animationGeneration: 0, expanded: true, closing: false, current: null,
        queue: [], event: null, hidden: () => false,
        animationsEnabled: () => true, animDuration: value => value,
        root: actor(), surface: actor(), preview: actor(), content: actor(),
        compact: actor(), osdChip: actor(), musicChip: actor(), pillSeparator: actor(), pillBadge: actor(),
        backdrop: {setVisible(value) { this.visible = value; }, update() {}},
        layout() {}, refreshTicker() {}, armPreview() {},
        nextPreview() { this.previewAdvances = (this.previewAdvances ?? 0) + 1; },
    });
    return island;
}
{
    const island = fixture();
    island.close(true);
    const staleClose = island.root.transitions.at(-1).onComplete;
    assert.equal(island.closing, true);
    island.hidden = () => true;
    island.visibility();
    staleClose();
    assert.equal(island.root.visible, false, 'overview must keep popup hidden after late completion');
    assert.equal(island.content.visible, false);
    assert.equal(island.backdrop.visible, false);
    assert.equal(island.closing, false);
    assert.equal(island.previewAdvances, undefined, 'stale close must not advance previews');
}
{
    const island = fixture();
    island.close(true);
    const staleClose = island.root.transitions.at(-1).onComplete;
    island.close(false);
    assert.equal(island.closing, false, 'immediate close must settle an in-progress dismissal');
    assert.equal(island.content.visible, false);
    const advances = island.previewAdvances;
    staleClose();
    assert.equal(island.previewAdvances, advances);
}
{
    const island = fixture();
    island.expanded = false;
    island.current = {notification: {}};
    island.clearPreview(true);
    const stalePreview = island.root.transitions.at(-1).onComplete;
    island.cancelPopupAnimation();
    const replacement = {notification: {}};
    island.current = replacement;
    stalePreview();
    assert.equal(island.current, replacement, 'old completion must not clear a replacement notification');
}
{
    const island = fixture();
    island.layout = Island.prototype.layout;
    island.getSettingDouble = (_key, value) => value;
    island.getSettingInt = (_key, value) => value;
    island.getSettingString = (_key, value) => value;
    island.compact = actor();
    island.history = {};
    island.surface.get_preferred_height = () => [100, 300];
    island.close(true);
    const dismissal = island.root.transitions[0];
    island.layout();
    assert.equal(island.root.transitions.includes(dismissal), true, 'layout must preserve dismissal callback');
    assert.deepEqual(island.root.removed, ['width', 'height', 'x', 'y']);
    assert.equal(island.root.visible, true, 'routine layout must let close animation finish');
}
{
    const backdrop = Object.create(Backdrop.prototype);
    let destroys = 0;
    Object.assign(backdrop, {
        visible: true, generation: 3, actor: actor(), root: actor(),
        pipeline: {destroy() { destroys++; }},
    });
    backdrop.setVisible(false);
    assert.equal(backdrop.generation, 4, 'hide invalidates pending pipeline imports');
    assert.equal(backdrop.actor.visible, false);
    assert.equal(backdrop.pipeline, null);
    assert.equal(destroys, 1);
    backdrop.setVisible(false);
    assert.equal(destroys, 1, 'repeat hide must not destroy twice');
}
{
    const island = fixture();
    island.music = {state: {connected: true, present: true, playing: false, title: 'Paused track', identity: 'VLC'}};
    for (const key of ['nowPlayingTag', 'title', 'artist', 'album', 'smallCover', 'cover',
        'play', 'previous', 'next', 'slider', 'raiseBtn', 'compactTitle', 'wave', 'player', 'playerDivider'])
        island[key] = actor();
    island.play.child = {};
    island.syncPlayerSelector = () => {};
    island.appearance = () => {};
    island.updateNotifBadge = () => {};
    island.progress = () => {};
    island.getSettingBool = () => true;
    island.updateMusic();
    assert.equal(island.musicChip.visible, true, 'paused player keeps panel chip');
    assert.equal(island.player.visible, true, 'paused player keeps expanded card');
    assert.equal(island.compactTitle.text, 'Paused track');
    assert.equal(island.compact.classes.has('liquid-playing'), false, 'paused player has no playing animation style');
    island.getSettingBool = () => false;
    island.updateMusic();
    assert.equal(island.musicChip.visible, false, 'integration switch hides panel chip');
    assert.equal(island.player.visible, false, 'integration switch hides expanded card');
}
{
    const island = fixture();
    const names = ['music', 'quick', 'telemetry', 'notifications', 'calendar'];
    island.moduleActors = Object.fromEntries(names.map(name => [name, [{name}]]));
    const indices = [];
    island.content.set_child_at_index = (child, index) => indices.push([child.name, index]);
    island.getSettingStrv = () => ['calendar', 'calendar', '__proto__', 'music'];
    island.syncModuleOrder();
    assert.deepEqual(indices, [['calendar', 2], ['music', 3], ['quick', 4], ['telemetry', 5], ['notifications', 6]],
        'module order removes duplicates/invalid IDs and appends omitted modules');
}
console.log('overview lifecycle: 7 scenarios passed (mocked actor lifecycle; no live Shell validation)');
