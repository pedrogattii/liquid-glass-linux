import Gio from 'gi://Gio';
import UPower from 'gi://UPowerGlib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Lifetime} from './lifecycle.js';

export class SystemEvents {
    constructor(show, hidden) {
        this.life = new Lifetime();
        this.cancel = new Gio.Cancellable();
        this.injections = new InjectionManager();
        const controller = this;
        this.injections.overrideMethod(Main.osdWindowManager, '_showOsdWindow', original =>
            function (monitor, icon, label, level, maxLevel) {
                // Leave OSDs on secondary monitors and during fullscreen alone.
                if (hidden() || monitor !== Main.layoutManager.primaryIndex)
                    return original.call(this, monitor, icon, label, level, maxLevel);
                const names = icon?.get_names?.() ?? [];
                const isVolume = names.some(name => name.includes('audio-volume'));
                const isBrightness = names.some(name => name.includes('brightness'));
                if (!isVolume && !isBrightness)
                    return original.call(this, monitor, icon, label, level, maxLevel);
                const handled = show({key: isVolume ? 'volume' : 'brightness', gicon: icon,
                    title: label || (isVolume ? 'Volumen' : 'Brillo'),
                    level: Number.isFinite(level) ? Math.max(0, Math.min(1, level / Math.max(1, maxLevel))) : null});
                if (!handled)
                    return original.call(this, monitor, icon, label, level, maxLevel);
                return undefined;
            });
        // UPower owns battery thresholds. No continuous polling or invented %.
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE,
            null, 'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', this.cancel, (_obj, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (!this.life.alive)
                        return;
                    this.battery = proxy;
                    this.lastCharging = this.charging();
                    this.lastWarning = this.value('WarningLevel', 0);
                    this.life.connect(proxy, 'g-properties-changed', () => {
                        const charging = this.charging();
                        const warning = this.value('WarningLevel', 0);
                        if (this.value('IsPresent', false) && !hidden()) {
                            const percent = Math.round(this.value('Percentage', 0));
                            if (charging !== this.lastCharging)
                                show({key: 'battery', icon: charging ? 'battery-good-charging-symbolic' : 'battery-good-symbolic',
                                    title: charging ? 'Cargador conectado' : 'Cargador desconectado',
                                    detail: `${percent} %`});
                            if (warning >= UPower.DeviceLevel.LOW && warning !== this.lastWarning)
                                show({key: 'battery', icon: 'battery-caution-symbolic',
                                    title: 'Batería baja', detail: `${percent} %`});
                        }
                        this.lastCharging = charging;
                        this.lastWarning = warning;
                    });
                } catch (error) {
                    if (this.life.alive)
                        console.debug(`Liquid Island battery: ${error.message}`);
                }
            });
    }

    value(name, fallback) {
        return this.battery?.get_cached_property(name)?.deep_unpack() ?? fallback;
    }

    charging() {
        return [UPower.DeviceState.CHARGING, UPower.DeviceState.FULLY_CHARGED,
            UPower.DeviceState.PENDING_CHARGE].includes(this.value('State', 0));
    }

    destroy() {
        this.injections.clear();
        this.cancel.cancel();
        this.life.destroy();
        this.battery = null;
    }
}
