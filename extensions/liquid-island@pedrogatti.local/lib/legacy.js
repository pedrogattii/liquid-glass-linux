import Gio from 'gi://Gio';
import {Lifetime} from './lifecycle.js';

const SERVICE = 'spotify-glass-widget.service';

// One-time handoff only after the new UI has survived its first frames.
// No daemon, polling loop or permanent extra process is needed.
export class LegacyWidget {
    constructor(settings, ready) {
        this.settings = settings;
        this.life = new Lifetime();
        this.cancellable = new Gio.Cancellable();
        this.pending = false;
        try {
            if (settings.get_boolean('manage-legacy-widget')) {
                this.life.after(4000, () => {
                    if (!ready())
                        return;
                    this.pending = true;
                    this.run(['disable', '--now', SERVICE], success => {
                        this.pending = false;
                        try {
                            if (success)
                                settings.set_boolean('legacy-suspended', true);
                        } catch (_) {}
                        if (!this.life.alive && success)
                            this.restore();
                    });
                });
            }
        } catch (_) {}
    }

    run(args, done = () => {}, cancellable = this.cancellable) {
        try {
            const process = Gio.Subprocess.new(['systemctl', '--user', ...args],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            process.wait_check_async(cancellable, (proc, result) => {
                let success = false;
                try { success = proc.wait_check_finish(result); } catch (_) { /* no legacy service */ }
                done(success);
            });
        } catch (_) { done(false); }
    }

    restore() {
        try {
            if (!this.settings.get_boolean('legacy-suspended'))
                return;
        } catch (_) {
            return;
        }
        const cancellable = this.cancellable.is_cancelled() ? new Gio.Cancellable() : this.cancellable;
        let operation = 'disable';
        let wasActive = false;
        try {
            operation = this.settings.get_boolean('legacy-was-enabled') ? 'enable' : 'disable';
            wasActive = this.settings.get_boolean('legacy-was-active');
        } catch (_) {}
        this.run([operation, SERVICE], success => {
            if (!success)
                return;
            if (wasActive) {
                this.run(['start', SERVICE], started => {
                    if (started) {
                        try { this.settings.set_boolean('legacy-suspended', false); } catch (_) {}
                    }
                }, cancellable);
            } else {
                try { this.settings.set_boolean('legacy-suspended', false); } catch (_) {}
            }
        }, cancellable);
    }

    destroy() {
        this.life.destroy();
        this.cancellable.cancel();
        if (!this.pending)
            this.restore();
    }
}
