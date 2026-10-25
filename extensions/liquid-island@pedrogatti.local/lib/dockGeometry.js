export function dockGeometry(monitor, width, height, edge = 'bottom', scale = 1, panelHeight = 0) {
    const vertical = edge === 'left' || edge === 'right';
    const margin = 12 * scale;
    const x = edge === 'left' ? monitor.x + margin : edge === 'right'
        ? monitor.x + monitor.width - width - margin : monitor.x + (monitor.width - width) / 2;
    const y = edge === 'top' ? monitor.y + panelHeight + margin : edge === 'bottom'
        ? monitor.y + monitor.height - height - margin : monitor.y + panelHeight + (monitor.height - panelHeight - height) / 2;
    const span = Math.min(vertical ? monitor.height - panelHeight : monitor.width,
        Math.max((vertical ? height : width) + 80 * scale, 200 * scale));
    const trigger = vertical
        ? {x: edge === 'left' ? monitor.x : monitor.x + monitor.width - 3, y: monitor.y + panelHeight + (monitor.height - panelHeight - span) / 2, width: 3, height: span}
        : {x: monitor.x + (monitor.width - span) / 2, y: edge === 'top' ? monitor.y + panelHeight : monitor.y + monitor.height - 3, width: span, height: 3};
    return {x: Math.round(x), y: Math.round(y), trigger, vertical,
        hideX: edge === 'left' ? -28 : edge === 'right' ? 28 : 0,
        hideY: edge === 'top' ? -28 : edge === 'bottom' ? 28 : 0};
}
