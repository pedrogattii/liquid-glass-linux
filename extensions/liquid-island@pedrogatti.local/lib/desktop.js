import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {Lifetime} from './lifecycle.js';
import {Backdrop} from './backdrop.js';
import {dockGeometry} from './dockGeometry.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export class Desktop {
    constructor(settings, hidden, openPreferences = () => {}) {
        this.life = new Lifetime();
        this.settings = settings;
        this.hidden = hidden;
        this.openPreferences = openPreferences;
        this.panelOriginalOrder = new Map();
        this.nativeDashState = null;
        this.backgroundMenus = [];
        this.backgroundManagers = new Set();
        this.interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.apps = Shell.AppSystem.get_default();
        this.favorites = AppFavorites.getAppFavorites();
        this.tracker = Shell.WindowTracker.get_default();
        this.refreshId = 0;
        this.hideTimeoutId = 0;
        this.edgeHovered = false;
        this.dockHovered = false;
        this.contextMenu = null;
        this.activeDrag = null;
        this.dockButtons = [];
        this.trackedWindows = new Set();
        this.windowLives = new Map();
        this.iconSize = 46;

        // Top panel launcher & context
        this.launcher = new PanelMenu.Button(0.0, 'Aplicaciones', true);
        const launch = new St.Button({
            can_focus: true,
            accessible_name: 'Abrir aplicaciones',
            style_class: 'liquid-panel-launcher',
            child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 16}),
        });
        launch.connect('clicked', () => Main.overview.showApps());
        this.launcher.add_child(launch);
        this.launcher.can_focus = false;
        Main.panel.addToStatusArea('liquidLauncher', this.launcher, 1, 'left');

        this.context = new PanelMenu.Button(0.0, 'Aplicación activa', true);
        this.appLabel = new St.Label({
            text: 'Escritorio',
            style_class: 'liquid-panel-context',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.appLabel.clutter_text.max_length = 28;
        const context = new St.Button({can_focus: true, child: this.appLabel});
        context.connect('clicked', () => this.tracker.focus_app?.activate());
        this.context.add_child(context);
        this.context.can_focus = false;
        Main.panel.addToStatusArea('liquidContext', this.context, 2, 'left');

        // Liquid Glass Dock
        this.dock = new St.Widget({
            name: 'liquid-dock',
            style_class: 'liquid-dock',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
        });
        this.row = new St.BoxLayout({style_class: 'liquid-dock-surface', x_expand: true});
        this.dock.add_child(this.row);
        this.backdrop = new Backdrop(this.dock, settings);
        Main.layoutManager.addChrome(this.dock, {affectsStruts: false, trackFullscreen: false});

        Main.ctrlAltTabManager.addGroup(this.dock, 'Aplicaciones', 'view-app-grid-symbolic');

        // 3px invisible reactive trigger bar at the bottom center of the primary monitor
        this.edgeTrigger = new St.Widget({
            name: 'liquid-dock-edge-trigger',
            reactive: true,
            track_hover: true,
            opacity: 0,
        });
        Main.layoutManager.addChrome(this.edgeTrigger, {affectsStruts: false, trackFullscreen: false});

        // Hover listeners for intellihide
        this.life.connect(this.edgeTrigger, 'notify::hover', () => {
            if (this.edgeTrigger.hover) {
                this.edgeHovered = true;
                this.revealDock(true);
            } else {
                this.edgeHovered = false;
                this.scheduleHideDock();
            }
        });

        this.life.connect(this.dock, 'notify::hover', () => {
            if (this.dock.hover) {
                this.dockHovered = true;
                this.revealDock(true);
            } else {
                this.dockHovered = false;
                this.updateMagnification(-1);
                this.scheduleHideDock();
            }
        });

        // Global stage event capture for context menu dismissal and drag reordering
        this.life.connect(global.stage, 'captured-event', (_stage, event) => this.onCapturedEvent(event));

        // Settings change listeners
        this.life.connect(settings, 'changed::desktop-style', () => this.updateVisibility(true));
        this.life.connect(settings, 'changed::dock-intellihide', () => this.updateVisibility(true));
        this.life.connect(settings, 'changed::dock-magnification', () => this.updateMagnification(-1));
        this.life.connect(settings, 'changed::dock-icon-size', () => this.refreshDock());
        this.life.connect(settings, 'changed::dock-max-apps', () => this.refreshDock());
        this.life.connect(settings, 'changed::dock-show-running', () => this.refreshDock());
        this.life.connect(settings, 'changed::dock-show-apps-button', () => this.refreshDock());

        // State listeners
        this.life.connect(this.apps, 'app-state-changed', () => this.schedule());
        this.life.connect(this.favorites, 'changed', () => this.schedule());
        this.life.connect(this.tracker, 'notify::focus-app', () => {
            this.schedule();
            this.updateVisibility(true);
        });
        this.life.connect(global.workspace_manager, 'active-workspace-changed', () => {
            this.watchActiveWorkspace();
            this.updateVisibility(true);
        });
        this.life.connect(global.display, 'notify::focus-window', () => this.updateVisibility(true));
        this.life.connect(global.display, 'restacked', () => this.updateVisibility(true));
        this.life.connect(global.display, 'window-created', (_d, win) => {
            this.trackWindow(win);
            this.updateVisibility(true);
        });
        this.life.connect(Main.layoutManager, 'monitors-changed', () => this.rebuild());
        this.life.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => this.rebuild());
        for (const sig of ['showing', 'shown', 'hiding', 'hidden'])
            this.life.connect(Main.overview, sig, () => this.updateVisibility(true));
        this.life.connect(Main.sessionMode, 'updated', () => this.updateVisibility(true));
        this.life.connect(global.display, 'in-fullscreen-changed', () => this.updateVisibility(true));

        for (const key of ['dock-position', 'panel-left-order', 'panel-right-order'])
            this.life.connect(settings, `changed::${key}`, () => { this.applyPanelOrder(); this.rebuild(); });
        this.life.connect(Main.layoutManager, 'monitors-changed', () => this.installBackgroundActions());
        this.life.connect(Main.panel._rightBox, 'child-added', () => {
            this.life.cancel(this.panelOrderId);
            this.panelOrderId = this.life.after(0, () => this.applyPanelOrder());
        });
        this.life.connect(settings, 'changed::widgets-edit-mode', () => {
            for (const item of this.backgroundMenus) {
                if (item instanceof PopupMenu.PopupSwitchMenuItem)
                    item.setToggleState(settings.get_boolean('widgets-edit-mode'));
            }
        });
        this.applyPanelOrder();
        this.installBackgroundActions();
        this.watchActiveWorkspace();
        this.rebuild();
    }

    getEdge() {
        return this.settings.get_string('dock-position');
    }

    vertical() {
        return ['left', 'right'].includes(this.getEdge());
    }

    applyPanelOrder() {
        for (const [side, box] of [['left', Main.panel._leftBox], ['right', Main.panel._rightBox]]) {
            if (!this.panelOriginalOrder.has(box))
                this.panelOriginalOrder.set(box, box.get_children());
            let index = 0;
            for (const role of this.settings.get_strv(`panel-${side}-order`)) {
                const roles = role === 'appindicators'
                    ? Object.keys(Main.panel.statusArea).filter(name => name.startsWith('appindicator-')) : [role];
                for (const name of roles) {
                    const actor = Main.panel.statusArea[name]?.container;
                    if (actor?.get_parent() === box)
                        box.set_child_at_index(actor, index++);
                }
            }
        }
    }

    installBackgroundActions() {
        for (const item of this.backgroundMenus)
            item.destroy();
        this.backgroundMenus = [];
        for (const manager of Main.layoutManager._bgManagers ?? []) {
            if (!this.backgroundManagers.has(manager)) {
                this.backgroundManagers.add(manager);
                this.life.connect(manager, 'changed', () => this.installBackgroundActions());
            }
            const actor = manager.backgroundActor;
            const menu = actor?._backgroundMenu;
            if (!menu)
                continue;
            const item = new PopupMenu.PopupMenuItem('Personalizar Liquid Glass…');
            item.connect('activate', () => this.openPreferences());
            menu.addMenuItem(item);
            this.backgroundMenus.push(item);
            const edit = new PopupMenu.PopupSwitchMenuItem('Editar widgets', this.settings.get_boolean('widgets-edit-mode'));
            edit.connect('toggled', (_item, value) => this.settings.set_boolean('widgets-edit-mode', value));
            menu.addMenuItem(edit);
            this.backgroundMenus.push(edit);
        }
    }

    placeDock(monitor, scale) {
        const width = this.row.get_preferred_width(-1)[1];
        const height = this.row.get_preferred_height(width)[1];
        const geometry = dockGeometry(monitor, width, height, this.getEdge(), scale, Main.panel.height);
        this.geometry = geometry;
        this.dock.set_size(width, height);
        this.dock.set_position(geometry.x, geometry.y);
        const t = geometry.trigger;
        this.edgeTrigger.set_position(Math.round(t.x), Math.round(t.y));
        this.edgeTrigger.set_size(Math.round(t.width), Math.round(t.height));
    }

    getBool(key, def = true) {
        try {
            return this.settings.get_boolean(key);
        } catch (e) {
            console.debug(e);
            return def;
        }
    }

    getInt(key, def = 0) {
        try {
            return this.settings.get_int(key);
        } catch (e) {
            console.debug(e);
            return def;
        }
    }

    animationsEnabled() {
        try {
            return this.interface ? this.interface.get_boolean('enable-animations') : true;
        } catch (e) {
            console.debug(e);
            return true;
        }
    }

    hideNativeDash() {
        try {
            if (Main.overview.dash) {
                if (!this.nativeDashState)
                    this.nativeDashState = {visible: Main.overview.dash.visible, opacity: Main.overview.dash.opacity, reactive: Main.overview.dash.reactive};
                Main.overview.dash.opacity = 0;
                Main.overview.dash.reactive = false;
                Main.overview.dash.hide();
            }
        } catch (e) {
            console.debug(e);
        }
    }

    restoreNativeDash() {
        try {
            if (Main.overview.dash && this.nativeDashState) {
                Main.overview.dash.opacity = this.nativeDashState.opacity;
                Main.overview.dash.reactive = this.nativeDashState.reactive;
                Main.overview.dash.visible = this.nativeDashState.visible;
                this.nativeDashState = null;
            }
        } catch (e) {
            console.debug(e);
        }
    }

    watchActiveWorkspace() {
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws)
            return;
        for (const win of ws.list_windows())
            this.trackWindow(win);
    }

    trackWindow(win) {
        if (!win || win._liquidTracked)
            return;
        win._liquidTracked = true;
        this.trackedWindows.add(win);
        const life = new Lifetime();
        this.windowLives.set(win, life);
        life.connect(win, 'notify::minimized', () => this.updateVisibility(true));
        life.connect(win, 'notify::maximized-horizontally', () => this.updateVisibility(true));
        life.connect(win, 'notify::maximized-vertically', () => this.updateVisibility(true));
        life.connect(win, 'workspace-changed', () => this.updateVisibility(true));
        life.connect(win, 'unmanaged', () => {
            life.destroy();
            this.windowLives.delete(win);
            this.trackedWindows.delete(win);
            try {
                delete win._liquidTracked;
            } catch (e) {
                console.debug(e);
            }
            this.updateVisibility(true);
        });
    }

    cleanupWindows() {
        for (const life of this.windowLives.values())
            life.destroy();
        this.windowLives.clear();
        for (const win of this.trackedWindows) {
            try {
                delete win._liquidTracked;
            } catch (e) {
                console.debug(e);
            }
        }
        this.trackedWindows.clear();
    }

    isAppOpen() {
        if (Main.overview.visible || Main.overview._shown)
            return false;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        if (global.display.get_monitor_in_fullscreen(monitor.index))
            return true;

        const workspace = global.workspace_manager.get_active_workspace();
        if (!workspace)
            return false;

        const windows = workspace.list_windows().filter(w => {
            if (!w || w.is_on_all_workspaces?.())
                return false;
            if (typeof w.get_monitor === 'function' && w.get_monitor() !== monitor.index)
                return false;
            if (w.minimized)
                return false;
            if (typeof w.showing_on_its_workspace === 'function' && !w.showing_on_its_workspace())
                return false;
            const type = typeof w.get_window_type === 'function' ? w.get_window_type() : 0;
            return type === 0 || type === 3 || type === 4;
        });

        return windows.length > 0;
    }

    activateOrToggleApp(app) {
        const focused = app === this.tracker.focus_app;
        if (focused) {
            const activeWin = global.display.focus_window;
            if (activeWin && this.tracker.get_window_app(activeWin) === app) {
                activeWin.minimize();
                return;
            }
        }
        app.activate();
    }

    closeContextMenu() {
        if (this.contextMenu) {
            const menu = this.contextMenu;
            this.contextMenu = null;
            try {
                Main.layoutManager.removeChrome(menu);
            } catch (e) {
                console.debug(e);
            }
            menu.destroy();
            if (this.isAppOpen() && this.getBool('dock-intellihide', true) && !this.edgeHovered && !this.dockHovered) {
                this.scheduleHideDock();
            }
        }
    }

    openContextMenu(button, app, isFavorite, favIndex, totalFavs) {
        this.closeContextMenu();

        const menu = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-dock-menu',
            reactive: true,
        });

        // App Name Header
        const title = new St.Label({
            text: app.get_name(),
            style_class: 'liquid-dock-menu-title',
        });
        menu.add_child(title);

        const addItem = (label, iconName, action) => {
            const item = new St.Button({
                style_class: 'liquid-dock-menu-item',
                can_focus: true,
                reactive: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            const box = new St.BoxLayout({
                style_class: 'liquid-dock-menu-item-box',
                style: 'spacing: 8px;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (iconName) {
                box.add_child(new St.Icon({
                    icon_name: iconName,
                    icon_size: 14,
                    style_class: 'liquid-dock-menu-icon',
                }));
            }
            box.add_child(new St.Label({
                text: label,
                style_class: 'liquid-dock-menu-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            item.set_child(box);
            item.connect('clicked', () => {
                this.closeContextMenu();
                try {
                    action();
                } catch (e) {
                    console.debug(e);
                }
            });
            menu.add_child(item);
        };

        // 1. "Abrir nueva ventana"
        addItem('Abrir nueva ventana', 'window-new-symbolic', () => {
            app.open_new_window(-1);
        });

        // 2. Favorites actions
        if (isFavorite) {
            if (favIndex > 0) {
                addItem('← Mover a la izquierda', 'go-previous-symbolic', () => {
                    this.favorites.moveFavoriteToPos(app.get_id(), favIndex - 1);
                    this.schedule();
                });
            }
            if (favIndex < totalFavs - 1) {
                addItem('Mover a la derecha →', 'go-next-symbolic', () => {
                    this.favorites.moveFavoriteToPos(app.get_id(), favIndex + 1);
                    this.schedule();
                });
            }
            addItem('Desfijar del Dock', 'bookmark-remove-symbolic', () => {
                this.favorites.removeFavorite(app.get_id());
                this.schedule();
            });
        } else {
            addItem('Fijar en el Dock', 'bookmark-new-symbolic', () => {
                this.favorites.addFavorite(app.get_id());
                this.schedule();
            });
        }

        // 3. Running state action
        if (app.get_state() === Shell.AppState.RUNNING) {
            addItem('Cerrar aplicación', 'application-exit-symbolic', () => {
                app.request_quit();
            });
        }

        Main.layoutManager.addTopChrome(menu);
        this.contextMenu = menu;

        // Positioning right above button
        const [btnX, btnY] = button.get_transformed_position();
        const [btnW] = button.get_transformed_size();

        const [, natW] = menu.get_preferred_width(-1);
        const menuW = Math.max(160, natW);
        const [, menuH] = menu.get_preferred_height(menuW);

        let posX = Math.round(btnX + (btnW - menuW) / 2);
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            posX = Math.max(monitor.x + 8, Math.min(posX, monitor.x + monitor.width - menuW - 8));
        }

        let posY = Math.round(btnY - menuH - 8);
        if (monitor && posY < monitor.y + 30) {
            posY = Math.round(btnY + button.height + 8);
        }

        menu.set_position(posX, posY);

        if (this.animationsEnabled()) {
            menu.opacity = 0;
            menu.ease({
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    updateMagnification(hoveredIndex = -1) {
        const enabled = this.getBool('dock-magnification', true);
        for (let i = 0; i < this.dockButtons.length; i++) {
            const btn = this.dockButtons[i];
            let scale = 1.0;
            let transY = 0;

            if (enabled && hoveredIndex !== -1) {
                const dist = Math.abs(i - hoveredIndex);
                if (dist === 0) {
                    scale = 1.22;
                    transY = -6;
                } else if (dist === 1) {
                    scale = 1.08;
                    transY = -2;
                }
            }

            btn.ease({
                scale_x: scale,
                scale_y: scale,
                translation_x: this.vertical() ? (this.getEdge() === 'left' ? -transY : transY) : 0,
                translation_y: this.vertical() ? 0 : (this.getEdge() === 'top' ? -transY : transY),
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    onCapturedEvent(event) {
        // 1. Drag reordering
        if (this.activeDrag) {
            if (event.type() === Clutter.EventType.MOTION) {
                const [curX, curY] = event.get_coords();
                const deltaX = curX - this.activeDrag.startX;
                const deltaY = curY - this.activeDrag.startY;
                if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8)
                    this.activeDrag.dragged = true;

                if (this.activeDrag.dragged && this.activeDrag.isFavorite) {
                    this.activeDrag.button.translation_x = this.vertical() ? 0 : deltaX;
                    this.activeDrag.button.translation_y = this.vertical() ? deltaY : 0;
                    return Clutter.EVENT_STOP;
                }
            } else if (event.type() === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1) {
                const drag = this.activeDrag;
                this.activeDrag = null;

                if (drag.dragged) {
                    drag.button.ease({
                        translation_x: 0,
                        translation_y: 0,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    const [curX, curY] = event.get_coords();
                    const deltaX = this.vertical() ? curY - drag.startY : curX - drag.startX;
                    const slotWidth = this.iconSize + 10;
                    if (drag.isFavorite && Math.abs(deltaX) >= slotWidth) {
                        const shiftSlots = Math.round(deltaX / slotWidth);
                        const targetIndex = Math.max(0, Math.min(drag.totalFavs - 1, drag.favIndex + shiftSlots));
                        if (targetIndex !== drag.favIndex) {
                            this.favorites.moveFavoriteToPos(drag.app.get_id(), targetIndex);
                            this.schedule();
                        }
                    }
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }
        }

        // 2. Escape key handling
        if (event.type() === Clutter.EventType.KEY_PRESS) {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                if (this.activeDrag) {
                    this.activeDrag.button.ease({
                        translation_x: 0,
                        translation_y: 0,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    this.activeDrag = null;
                    return Clutter.EVENT_STOP;
                }
                if (this.contextMenu) {
                    this.closeContextMenu();
                    return Clutter.EVENT_STOP;
                }
            }
        }

        // 3. Click outside context menu
        if (this.contextMenu && [Clutter.EventType.BUTTON_PRESS, Clutter.EventType.TOUCH_BEGIN].includes(event.type())) {
            const source = global.stage.get_event_actor(event);
            if (source && !this.contextMenu.contains(source)) {
                this.closeContextMenu();
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    refreshDock() {
        this.rebuild();
    }

    schedule() {
        this.life.cancel(this.refreshId);
        this.refreshId = this.life.after(100, () => this.rebuild());
    }

    rebuild() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const iconSize = Math.max(28, Math.min(64, this.getInt('dock-icon-size', 46)));
        this.iconSize = iconSize;
        const maxApps = this.getInt('dock-max-apps', 18);
        const showRunning = this.getBool('dock-show-running', true);
        const showAppsBtn = this.getBool('dock-show-apps-button', true);

        this.row.orientation = this.vertical() ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        const available = this.vertical() ? monitor.height - Main.panel.height : monitor.width;
        const capacity = Math.max(1, Math.min(maxApps, Math.floor((available / scale - 120) / (iconSize + 16))));

        this.dockButtons = [];
        this.row.destroy_all_children();

        const favApps = this.favorites.getFavorites();
        const totalFavs = favApps.length;
        const favsToDisplay = favApps.slice(0, capacity);
        const favIds = new Set(favApps.map(a => a.get_id()));

        let runningToDisplay = [];
        if (showRunning) {
            const runningNonFavs = this.apps.get_running().filter(a => !favIds.has(a.get_id()));
            const remainingSlots = Math.max(0, capacity - favsToDisplay.length);
            runningToDisplay = runningNonFavs.slice(0, remainingSlots);
        }

        const createAppItem = (app, isFavorite, favIndex) => {
            const running = app.get_state() === Shell.AppState.RUNNING;
            const focused = app === this.tracker.focus_app;

            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'liquid-dock-app',
                style: 'spacing: 2px;',
                reactive: true,
            });

            const button = new St.Button({
                can_focus: true,
                reactive: true,
                accessible_name: app.get_name(),
                style_class: `liquid-dock-button${focused ? ' liquid-dock-focused' : ''}`,
                pivot_point: new Graphene.Point({x: 0.5, y: 1.0}),
            });

            const iconTexture = app.create_icon_texture(iconSize);
            button.set_child(iconTexture);

            button.connect('button-press-event', (_actor, event) => {
                const btn = event.get_button();
                if (btn === 3) {
                    this.openContextMenu(button, app, isFavorite, favIndex, totalFavs);
                    return Clutter.EVENT_STOP;
                }
                if (btn === 1) {
                    this.closeContextMenu();
                    const [startX, startY] = event.get_coords();
                    this.activeDrag = {
                        app,
                        button,
                        isFavorite,
                        favIndex,
                        totalFavs,
                        startX,
                        startY,
                        dragged: false,
                    };
                    return Clutter.EVENT_PROPAGATE;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            button.connect('clicked', () => {
                if (!this.activeDrag || !this.activeDrag.dragged) {
                    this.activateOrToggleApp(app);
                }
            });

            button.connect('notify::hover', () => {
                if (this.activeDrag)
                    return;
                if (button.hover) {
                    const idx = this.dockButtons.indexOf(button);
                    this.updateMagnification(idx);
                } else {
                    const nextHovered = this.dockButtons.findIndex(b => b.hover);
                    this.updateMagnification(nextHovered);
                }
            });

            this.dockButtons.push(button);
            box.add_child(button);

            const dot = new St.Widget({
                style_class: `liquid-dock-dot${running ? ' liquid-dock-running' : ''}`,
                x_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(dot);
            this.row.add_child(box);
        };

        for (let i = 0; i < favsToDisplay.length; i++) {
            createAppItem(favsToDisplay[i], true, i);
        }

        if (showRunning && runningToDisplay.length > 0) {
            const separator = new St.Widget({
                style_class: 'liquid-dock-separator',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.row.add_child(separator);

            for (const app of runningToDisplay) {
                createAppItem(app, false, -1);
            }
        }

        if (showAppsBtn) {
            const applications = new St.Button({
                can_focus: true,
                reactive: true,
                accessible_name: 'Todas las aplicaciones',
                style_class: 'liquid-dock-button liquid-dock-grid',
                pivot_point: new Graphene.Point({x: 0.5, y: 1.0}),
                child: new St.Icon({
                    icon_name: 'view-app-grid-symbolic',
                    icon_size: Math.max(16, iconSize - 6),
                }),
            });
            applications.connect('clicked', () => {
                if (Main.overview.visible)
                    Main.overview.hide();
                else
                    Main.overview.showApps();
            });
            applications.connect('notify::hover', () => {
                if (this.activeDrag)
                    return;
                if (applications.hover) {
                    const idx = this.dockButtons.indexOf(applications);
                    this.updateMagnification(idx);
                } else {
                    const nextHovered = this.dockButtons.findIndex(b => b.hover);
                    this.updateMagnification(nextHovered);
                }
            });
            this.dockButtons.push(applications);
            this.row.add_child(applications);
        }

        this.appLabel.text = this.tracker.focus_app?.get_name() ?? 'Escritorio';

        this.placeDock(monitor, scale);

        this.watchActiveWorkspace();
        this.updateVisibility(false);
    }

    revealDock(animate = true) {
        this.backdrop.setVisible(true);
        if (this.hideTimeoutId) {
            this.life.cancel(this.hideTimeoutId);
            this.hideTimeoutId = 0;
        }
        if (this.dock.visible && this.dock.translation_y === 0 && this.dock.translation_x === 0 && this.dock.opacity === 255)
            return;

        this.dock.remove_all_transitions();
        this.dock.show();
        if (animate && this.animationsEnabled()) {
            this.dock.translation_x = this.geometry?.hideX ?? 0;
            this.dock.translation_y = this.geometry?.hideY ?? 28;
            this.dock.opacity = 0;
            this.dock.ease({
                translation_x: 0,
                translation_y: 0,
                opacity: 255,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.dock.translation_x = 0;
            this.dock.translation_y = 0;
            this.dock.opacity = 255;
        }
    }

    hideDock() {
        this.dock.remove_all_transitions();
        if (this.animationsEnabled()) {
            this.dock.ease({
                translation_x: this.geometry?.hideX ?? 0,
                translation_y: this.geometry?.hideY ?? 28,
                opacity: 0,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (!this.edgeHovered && !this.dockHovered && !this.contextMenu) {
                        this.dock.hide();
                        this.backdrop.setVisible(false);
                    }
                },
            });
        } else {
            this.dock.translation_x = this.geometry?.hideX ?? 0;
            this.dock.translation_y = this.geometry?.hideY ?? 28;
            this.dock.opacity = 0;
            this.dock.hide();
            this.backdrop.setVisible(false);
        }
    }

    scheduleHideDock() {
        if (!this.life.alive)
            return;
        if (this.hideTimeoutId)
            this.life.cancel(this.hideTimeoutId);

        this.hideTimeoutId = this.life.after(350, () => {
            this.hideTimeoutId = 0;
            if (!this.edgeHovered && !this.dockHovered && !this.contextMenu) {
                if (this.isAppOpen() && this.getBool('dock-intellihide', true) && !Main.overview.visible) {
                    this.hideDock();
                }
            }
        });
    }

    updateVisibility(animate = true) {
        const enabled = this.getBool('desktop-style', true);
        if (!enabled || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            this.restoreNativeDash();
            this.dock.remove_all_transitions();
            this.dock.hide();
            this.backdrop.setVisible(false);
            if (this.edgeTrigger)
                this.edgeTrigger.hide();
            this.closeContextMenu();
            this.launcher.container.visible = false;
            this.context.container.visible = false;
            return;
        }

        this.hideNativeDash();
        this.launcher.container.visible = true;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this.context.container.visible = monitor.width >= 1000 * scale;

        const inOverview = Boolean(Main.overview.visible || Main.overview._shown);
        const appOpen = this.isAppOpen();
        const intellihide = this.getBool('dock-intellihide', true);

        this.placeDock(monitor, scale);
        this.edgeTrigger.visible = appOpen && intellihide && !inOverview;

        const shouldBeVisible = inOverview || !appOpen || !intellihide || (intellihide && (this.edgeHovered || this.dockHovered || Boolean(this.contextMenu)));

        if (shouldBeVisible) {
            if (!this.dock.visible || this.dock.opacity < 255 || this.dock.translation_y !== 0 || this.dock.translation_x !== 0) {
                this.revealDock(animate);
            }
        } else {
            if (this.dock.visible) {
                if (animate && this.animationsEnabled()) {
                    this.hideDock();
                } else {
                    this.dock.remove_all_transitions();
                    this.dock.translation_x = this.geometry?.hideX ?? 0;
                    this.dock.translation_y = this.geometry?.hideY ?? 28;
                    this.dock.opacity = 0;
                    this.dock.hide();
                    this.backdrop.setVisible(false);
                }
            }
        }
    }

    destroy() {
        this.life.destroy();
        for (const item of this.backgroundMenus)
            item.destroy();
        this.backgroundMenus = [];
        for (const [box, actors] of this.panelOriginalOrder) {
            let index = 0;
            for (const actor of actors) {
                if (actor.get_parent() === box)
                    box.set_child_at_index(actor, index++);
            }
        }
        this.panelOriginalOrder.clear();
        if (this.hideTimeoutId) {
            this.life.cancel(this.hideTimeoutId);
            this.hideTimeoutId = 0;
        }
        this.closeContextMenu();
        if (this.edgeTrigger) {
            try {
                Main.layoutManager.removeChrome(this.edgeTrigger);
            } catch (e) {
                console.debug(e);
            }
            this.edgeTrigger.destroy();
            this.edgeTrigger = null;
        }
        this.restoreNativeDash();
        this.cleanupWindows();
        this.dock.remove_all_transitions();
        this.dock.hide();
        this.backdrop.setVisible(false);
        this.launcher.destroy();
        this.context.destroy();
        this.backdrop.destroy();
        try {
            Main.ctrlAltTabManager.removeGroup(this.dock);
        } catch (e) {
            console.debug(e);
        }
        try {
            Main.layoutManager.removeChrome(this.dock);
        } catch (e) {
            console.debug(e);
        }
        this.dock.destroy();
        this.dock = null;
        this.row = null;
        this.launcher = null;
        this.context = null;
        this.backdrop = null;
        this.interface = null;
        this.appLabel = null;
        this.apps = null;
        this.favorites = null;
        this.tracker = null;
        this.settings = null;
        this.dockButtons = [];
        this.activeDrag = null;
    }
}
