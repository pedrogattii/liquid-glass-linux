import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {Lifetime} from './lifecycle.js';
import {Backdrop} from './backdrop.js';

export class Desktop {
    constructor(settings, hidden) {
        this.life = new Lifetime();
        this.settings = settings;
        this.hidden = hidden;
        this.interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.apps = Shell.AppSystem.get_default();
        this.favorites = AppFavorites.getAppFavorites();
        this.tracker = Shell.WindowTracker.get_default();
        this.refreshId = 0;

        // Top panel launcher & context
        this.launcher = new PanelMenu.Button(0.0, 'Aplicaciones', true);
        const launch = new St.Button({can_focus: true, accessible_name: 'Abrir aplicaciones',
            style_class: 'liquid-panel-launcher', child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 16})});
        launch.connect('clicked', () => Main.overview.showApps());
        this.launcher.add_child(launch);
        this.launcher.can_focus = false;
        Main.panel.addToStatusArea('liquidLauncher', this.launcher, 1, 'left');

        this.context = new PanelMenu.Button(0.0, 'Aplicación activa', true);
        this.appLabel = new St.Label({text: 'Escritorio', style_class: 'liquid-panel-context',
            y_align: Clutter.ActorAlign.CENTER});
        this.appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.appLabel.clutter_text.max_length = 28;
        const context = new St.Button({can_focus: true, child: this.appLabel});
        context.connect('clicked', () => this.tracker.focus_app?.activate());
        this.context.add_child(context);
        this.context.can_focus = false;
        Main.panel.addToStatusArea('liquidContext', this.context, 2, 'left');

        // Liquid Glass Dock
        this.dock = new St.Widget({style_class: 'liquid-dock',
            layout_manager: new Clutter.BinLayout(), reactive: true, track_hover: true});
        this.row = new St.BoxLayout({style_class: 'liquid-dock-surface', x_expand: true});
        this.dock.add_child(this.row);
        this.backdrop = new Backdrop(this.dock, settings);
        Main.layoutManager.addChrome(this.dock, {affectsStruts: false, trackFullscreen: false});

        Main.ctrlAltTabManager.addGroup(this.dock, 'Aplicaciones', 'view-app-grid-symbolic');

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
        this.life.connect(settings, 'changed::desktop-style', () => this.updateVisibility(true));
        for (const sig of ['showing', 'shown', 'hiding', 'hidden'])
            this.life.connect(Main.overview, sig, () => this.updateVisibility(true));
        this.life.connect(Main.sessionMode, 'updated', () => this.updateVisibility(true));
        this.life.connect(global.display, 'in-fullscreen-changed', () => this.updateVisibility(true));

        this.hideNativeDash();
        this.watchActiveWorkspace();
        this.rebuild();
    }

    animationsEnabled() {
        return this.interface.get_boolean('enable-animations');
    }

    hideNativeDash() {
        try {
            if (Main.overview.dash) {
                Main.overview.dash.opacity = 0;
                Main.overview.dash.reactive = false;
                Main.overview.dash.hide();
            }
        } catch (_) {}
    }

    restoreNativeDash() {
        try {
            if (Main.overview.dash) {
                Main.overview.dash.opacity = 255;
                Main.overview.dash.reactive = true;
                Main.overview.dash.show();
            }
        } catch (_) {}
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
        this.life.connect(win, 'notify::minimized', () => this.updateVisibility(true));
        this.life.connect(win, 'notify::maximized-horizontally', () => this.updateVisibility(true));
        this.life.connect(win, 'notify::maximized-vertically', () => this.updateVisibility(true));
        this.life.connect(win, 'workspace-changed', () => this.updateVisibility(true));
        this.life.connect(win, 'unmanaged', () => this.updateVisibility(true));
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

    schedule() {
        this.life.cancel(this.refreshId);
        this.refreshId = this.life.after(100, () => this.rebuild());
    }

    rebuild() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const iconSize = monitor.width < 1100 * scale ? 32 : 40;
        const capacity = Math.max(3, Math.min(12, Math.floor((monitor.width / scale - 80) / (iconSize + 18)) - 1));
        this.row.destroy_all_children();
        const seen = new Set();
        const apps = [...this.favorites.getFavorites(), ...this.apps.get_running()]
            .filter(app => { const id = app.get_id(); if (seen.has(id)) return false; seen.add(id); return true; });
        for (const app of apps.slice(0, capacity)) {
            const running = app.get_state() === Shell.AppState.RUNNING;
            const focused = app === this.tracker.focus_app;
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style_class: 'liquid-dock-app', style: 'spacing: 3px;'});
            const button = new St.Button({child: app.create_icon_texture(iconSize),
                can_focus: true, accessible_name: app.get_name(),
                style_class: `liquid-dock-button${focused ? ' liquid-dock-focused' : ''}`});
            button.connect('clicked', () => app.activate());
            box.add_child(button);
            box.add_child(new St.Widget({style_class: `liquid-dock-dot${running ? ' liquid-dock-running' : ''}`,
                x_align: Clutter.ActorAlign.CENTER}));
            this.row.add_child(box);
        }
        const applications = new St.Button({can_focus: true, accessible_name: 'Todas las aplicaciones',
            style_class: 'liquid-dock-button liquid-dock-grid',
            child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: iconSize - 6})});
        applications.connect('clicked', () => Main.overview.showApps());
        this.row.add_child(applications);
        this.appLabel.text = this.tracker.focus_app?.get_name() ?? 'Escritorio';
        const width = this.row.get_preferred_width(-1)[1];
        const height = this.row.get_preferred_height(width)[1];
        this.dock.set_size(width, height);
        this.watchActiveWorkspace();
        this.updateVisibility(false);
    }

    updateVisibility(animate = true) {
        this.hideNativeDash();
        const enabled = this.settings.get_boolean('desktop-style');
        if (!enabled || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            this.dock.remove_all_transitions();
            this.dock.hide();
            this.launcher.container.visible = false;
            this.context.container.visible = false;
            return;
        }

        this.launcher.container.visible = true;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.context.container.visible = (Main.layoutManager.primaryMonitor?.width ?? 0) >= 1000 * scale;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const inOverview = Boolean(Main.overview.visible || Main.overview._shown);
        const appOpen = this.isAppOpen();
        const shouldShow = inOverview || !appOpen;

        const width = this.row.get_preferred_width(-1)[1];
        const height = this.row.get_preferred_height(width)[1];
        const targetX = Math.round(monitor.x + (monitor.width - width) / 2);
        const targetY = monitor.y + monitor.height - height - 12 * scale;
        const hiddenY = monitor.y + monitor.height + 20;

        this.dock.remove_all_transitions();

        if (shouldShow) {
            this.dock.set_position(targetX, targetY);
            this.dock.opacity = 255;
            this.dock.show();
        } else {
            // When an application is active/open, the dock must be hidden completely like native
            this.dock.hide();
            this.dock.set_position(targetX, hiddenY);
            this.dock.opacity = 0;
        }
    }

    destroy() {
        this.restoreNativeDash();
        this.life.destroy();
        this.dock.remove_all_transitions();
        this.dock.hide();
        this.launcher.destroy();
        this.context.destroy();
        this.backdrop.destroy();
        Main.ctrlAltTabManager.removeGroup(this.dock);
        Main.layoutManager.removeChrome(this.dock);
        this.dock.destroy();
    }
}
