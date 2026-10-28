---
name: gnome-rice-architect
description: >-
  Expert architect and runbook for Linux desktop ricing and customization, specialized in GNOME Shell
  extensions, Clutter/St UI components, GTK4/Libadwaita theming, Liquid Glass frosted surfaces,
  MPRIS2 media control, native notifications interceptors, and hardware-accelerated live wallpapers.
---

# GNOME Rice Architect & Desktop Customization Skill

This skill guides the design, implementation, debugging, and live-reloading of high-fidelity desktop customizations, translucent glass surfaces, and native-feeling shell extensions on Linux (GNOME Shell 45, 46, 47, and 50+ on Wayland and X11).

---

## 1. Core Architecture: GNOME Shell ESM Extensions

Modern GNOME Shell extensions (version 45+) use standard ECMAScript Modules (`import` / `export`) executed by GJS (SpiderMonkey JavaScript engine).

### Lifecycle Rules
- **No permanent background daemons when Shell mechanisms suffice:** Rely on GLib signals, DBus signal subscriptions (`Gio.DBus.session.signal_subscribe`), and Clutter event captures instead of infinite `while` loops or separate polling daemons.
- **Strict cleanup in `disable()` and `destroy()`:**
  - Disconnect all GObject signals via a dedicated `Lifetime` tracker.
  - Cancel all pending GLib timeouts (`GLib.source_remove`) and Cancellables (`Gio.Cancellable.cancel()`).
  - Restore any native GNOME widgets that were hidden (e.g. `Main.panel.statusArea.dateMenu.container.show()`, `Main.messageTray.bannerBlocked = false`).
  - Remove UI chrome actors from `Main.layoutManager.removeChrome()`.

```javascript
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MyGlassExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        // Initialize components
    }

    disable() {
        // Destroy components and restore native state atomically
        this.settings = null;
    }
}
```

---

## 2. Liquid Glass Design System & St/Clutter Styling

Liquid Glass delivers a translucent, frosted glass aesthetic inspired by macOS Sonoma and Tahoe, accelerated by GPU Dual-Kawase shaders (`blur-my-shell`).

### Principles of Translucent Surfaces:
1. **Never use 100% opaque CSS backgrounds:**
   Always use semi-transparent rgba gradients with subtle specular top borders:
   ```css
   .liquid-surface {
     background-color: rgba(18, 22, 32, 0.40);
     background-gradient-direction: vertical;
     background-gradient-start: rgba(255, 255, 255, 0.16);
     background-gradient-end: rgba(10, 14, 22, 0.26);
     border: 1px solid rgba(255, 255, 255, 0.22);
     border-top: 1.5px solid rgba(255, 255, 255, 0.65); /* Specular rim */
     border-radius: 28px;
     box-shadow: 0 16px 45px 0 rgba(0, 0, 0, 0.40);
   }
   ```
2. **Preventing Dark Rectangles (Artifact Prevention):**
   When pairing Clutter background effects (`Shell.BlurEffect`) with rounded corners:
   - Avoid `clip_to_allocation: true` on parent actors that cast large blurry box-shadows.
   - Synchronize the CSS `border-radius` with any internal clutter mask.
3. **HiDPI Mathematical Centering (Zero Layout Shift):**
   Never anchor central floating widgets to fluctuating box sizes (`_centerBox`). Always calculate absolute monitor coordinates:
   ```javascript
   const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
   const width = Math.min(420 * scale, monitor.width - 32 * scale);
   const monitorCenterX = monitor.x + monitor.width / 2;
   const x = Math.round(monitorCenterX - width / 2);
   ```

---

## 3. Native Spring Animations (Apple-like Physics)

To give popups, banners, and Dynamic Island widgets a truly native feel:
- Use `Clutter.AnimationMode.EASE_OUT_BACK` for opening transitions (subtle spring overshoot).
- Animate both translation, opacity, and scale together:
```javascript
actor.translation_y = -18 * scale;
actor.scale_y = 0.88;
actor.scale_x = 0.95;
actor.opacity = 0;
actor.ease({
    translation_y: 0,
    scale_y: 1.0,
    scale_x: 1.0,
    opacity: 255,
    duration: 320,
    mode: Clutter.AnimationMode.EASE_OUT_BACK,
});
```
- For dismissals, use `Clutter.AnimationMode.EASE_IN_CUBIC` in 180–200ms, collapsing back into the pill before hiding.

---

## 4. MPRIS2 Universal Audio Integration

Listen to any active media player without vendor lock-in:
1. Subscribe to DBus `NameOwnerChanged` for names starting with `org.mpris.MediaPlayer2`:
   ```javascript
   Gio.DBus.session.signal_subscribe(
       'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
       '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
       (_c, _s, _p, _i, _n, params) => {
           if (params.deep_unpack()[0].startsWith('org.mpris.MediaPlayer2'))
               this.discover();
       }
   );
   ```
2. Dynamically prioritize players that are actively playing (`PlaybackStatus === 'Playing'`).
3. Only display the media pill/chip in the panel and expanded player when `state.playing` is active.

---

## 5. Live Wallpapers with Hardware Acceleration

To run video wallpapers on Linux with minimal battery/CPU consumption:
- **Wayland (wlroots / Hyprland / Sway):** `mpvpaper` with `--hwdec=auto --loop-file=inf --no-audio --vo=gpu`.
- **GNOME Shell (Mutter Wayland):** Use `gnome-live-wallpaper` (built on GStreamer/mpv) or static high-res poster with dynamic shaders.
- **Auto-pause on Fullscreen:** Always suspend playback when games or fullscreen video players are active.

---

## 6. Development & Live Debugging Runbook

### Reloading Extensions on Wayland:
Because `Alt + F2 -> 'r'` is disabled on Wayland, live-reload via DBus:
```bash
DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" gnome-extensions disable <UUID>
sleep 0.5
DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" gnome-extensions enable <UUID>
```

### Inspecting Errors in Live Session:
```bash
journalctl --user -b --since "1 minute ago" -o cat | grep -iE "(liquid|error|exception)"
```

### Looking Glass:
Press `Alt + F2`, type `lg`, and press Enter to inspect the live Clutter actor tree, CSS styles, and test JavaScript expressions interactively.
