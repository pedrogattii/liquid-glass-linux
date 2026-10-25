import Gio from 'gi://Gio';
import {Lifetime} from './lifecycle.js';

const SERVICE = 'spotify-glass-widget.service';

// One-time handoff only after the new UI has survived its first frames.
// No daemon, polling loop or permanent extra process is needed.
export class LegacyWidget {
    constructor(settings, ready) {
        this.settings = settings;
        this.life = new Lifetime();
        this.pending = false;
        if (settings.get_boolean('manage-legacy-widget')) {
            this.life.after(4000, () => {
                if (!ready())
                    return;
                this.pending = true;
                this.run(['disable', '--now', SERVICE], success => {
                    this.pending = false;
                    if (success)
                        settings.set_boolean('legacy-suspended', true);
                    if (!this.life.alive && success)
                        this.restore();
                });
            });
        }
    }

    run(args, done = () => {}) {
        try {
            const process = Gio.Subprocess.new(['systemctl', '--user', ...args],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            process.wait_check_async(null, (proc, result) => {
                let success = false;
                try { success = proc.wait_check_finish(result); } catch (_) { /* no legacy service */ }
                done(success);
            });
        } catch (_) { done(false); }
    }

    restore() {
        if (!this.settings.get_boolean('legacy-suspended'))
            return;
        const operation = this.settings.get_boolean('legacy-was-enabled') ? 'enable' : 'disable';
        this.run([operation, SERVICE], success => {
            if (!success)
                return;
            if (this.settings.get_boolean('legacy-was-active')) {
                this.run(['start', SERVICE], started => {
                    if (started)
                        this.settings.set_boolean('legacy-suspended', false);
                });
            } else {
                this.settings.set_boolean('legacy-suspended', false);
            }
        });
    }

    destroy() {
        this.life.destroy();
        if (!this.pending)
            this.restore();
    }
}
