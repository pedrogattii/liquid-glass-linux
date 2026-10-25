// Pure layout helpers shared by Shell, preferences and headless tests.
export const WIDGET_TYPES = Object.freeze(Object.fromEntries([
    ['clock', 'Reloj', 'alarm-symbolic', 260, 160],
    ['calendar', 'Calendario', 'x-office-calendar-symbolic', 340, 370],
    ['weather', 'Clima', 'weather-clear-symbolic', 280, 210],
    ['cpu', 'CPU', 'utilities-system-monitor-symbolic', 240, 150],
    ['ram', 'Memoria', 'drive-harddisk-symbolic', 240, 150],
    ['gpu', 'GPU', 'video-display-symbolic', 300, 210],
    ['music', 'Música', 'audio-x-generic-symbolic', 340, 230],
    ['launchers', 'Aplicaciones', 'view-app-grid-symbolic', 300, 190],
    ['notes', 'Notas', 'accessories-text-editor-symbolic', 300, 250],
    ['tasks', 'Tareas', 'view-list-symbolic', 300, 290],
    ['timer', 'Temporizador', 'hourglass-symbolic', 260, 210],
    ['discord', 'Discord', 'user-available-symbolic', 280, 190],
].map(([id, title, icon, width, height]) => [id, Object.freeze({
    id, title, icon, width, height, minWidth: Math.min(width, 200),
    minHeight: Math.min(height, 140),
})])));

const finite = (n, fallback) => typeof n === 'number' && Number.isFinite(n) ? n : fallback;
const limit = (n, min, max) => Math.max(min, Math.min(max, n));

export function parseWidgetLayout(text) {
    const result = {version: 1, widgets: {}};
    try {
        const value = JSON.parse(text);
        if (value?.version !== 1 || !value.widgets || Array.isArray(value.widgets))
            return result;
        for (const [type, item] of Object.entries(value.widgets)) {
            const spec = Object.hasOwn(WIDGET_TYPES, type) ? WIDGET_TYPES[type] : null;
            if (!spec || !item || typeof item !== 'object')
                continue;
            result.widgets[type] = {
                monitor: typeof item.monitor === 'string' ? item.monitor.slice(0, 200) : '',
                x: limit(finite(item.x, 24), -100000, 100000),
                y: limit(finite(item.y, 60), -100000, 100000),
                width: limit(finite(item.width, spec.width), spec.minWidth, 4000),
                height: limit(finite(item.height, spec.height), spec.minHeight, 4000),
            };
        }
    } catch (_) { /* Invalid or future layouts recover to defaults. */ }
    return result;
}

export function clampWidget(type, rect, monitor, snap = false) {
    const spec = WIDGET_TYPES[type];
    const grid = n => snap ? Math.round(n / 12) * 12 : n;
    const width = Math.round(limit(grid(finite(rect.width, spec.width)),
        Math.min(spec.minWidth, monitor.width), monitor.width));
    const height = Math.round(limit(grid(finite(rect.height, spec.height)),
        Math.min(spec.minHeight, monitor.height), monitor.height));
    return {monitor: monitor.connector,
        x: Math.round(limit(grid(finite(rect.x, 24)), 0, monitor.width - width)),
        y: Math.round(limit(grid(finite(rect.y, 60)), 0, monitor.height - height)),
        width, height};
}

// Keep saved connector preferences when displays disappear: recovery is a view,
// committed only after the user explicitly moves/resizes the recovered widget.
export function resolveWidget(type, saved, monitors, order = 0) {
    if (!monitors.length)
        return null;
    const monitor = monitors.find(m => m.connector === saved?.monitor) ??
        monitors.find(m => m.primary) ?? monitors[0];
    const columns = Math.max(1, Math.floor((monitor.width - 24) / 380));
    const rect = saved ?? {x: 24 + (order % columns) * 380, y: 60 + Math.floor(order / columns) * 400};
    return {monitor, rect: clampWidget(type, rect, monitor)};
}

export function parseWidgetTasks(text) {
    try {
        const value = JSON.parse(text);
        if (!Array.isArray(value))
            return [];
        return value.slice(0, 100).filter(item => item && typeof item.text === 'string')
            .map((item, i) => ({id: typeof item.id === 'string' ? item.id : String(i),
                text: item.text.slice(0, 1000), done: item.done === true}));
    } catch (_) { return []; }
}

export function timerRemaining(deadline, now, pausedSeconds) {
    return deadline === null ? pausedSeconds : Math.max(0, Math.ceil((deadline - now) / 1000000));
}

export function parseLayout(text) {
    const value = JSON.parse(text);
    if (value?.version !== 1 || !value.widgets || typeof value.widgets !== 'object' ||
        Array.isArray(value.widgets))
        throw new Error('Formato de distribución no compatible (se requiere versión 1).');
    for (const [type, item] of Object.entries(value.widgets)) {
        if (!Object.hasOwn(WIDGET_TYPES, type) || !item || typeof item.monitor !== 'string' ||
            !['x', 'y', 'width', 'height'].every(key =>
                typeof item[key] === 'number' && Number.isFinite(item[key])) ||
            item.width <= 0 || item.height <= 0)
            throw new Error(`Distribución no válida para ${type}.`);
    }
    return parseWidgetLayout(text);
}
