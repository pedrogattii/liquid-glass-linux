import assert from 'node:assert/strict';
import {dockGeometry} from '../extensions/liquid-island@pedrogatti.local/lib/dockGeometry.js';
const monitor = {x:1920,y:0,width:1920,height:1080};
for (const edge of ['bottom','top','left','right']) {
    const g = dockGeometry(monitor, edge==='left'||edge==='right'?80:500,
        edge==='left'||edge==='right'?500:80, edge,1,32);
    assert.ok(g.x>=monitor.x && g.x<monitor.x+monitor.width);
    assert.ok(g.y>=monitor.y+32 && g.y<monitor.height);
    assert.equal(g.vertical, ['left','right'].includes(edge));
    if (edge==='top') assert.equal(g.trigger.y,32);
    if (edge==='left') assert.equal(g.trigger.x,1920);
    if (edge==='right') assert.equal(g.trigger.x,3837);
    if (edge==='bottom') assert.equal(g.trigger.y,1077);
}
const scaled=dockGeometry({x:-2560,y:100,width:2560,height:1440},160,700,'left',2,64);
assert.equal(scaled.x,-2536);
assert.equal(scaled.hideX,-28);
assert.ok(scaled.trigger.y>=164);
console.log('dock geometry: four edges, panel clearance, scale and offset monitors passed');
