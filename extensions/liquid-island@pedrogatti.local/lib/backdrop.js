import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Lifetime} from './lifecycle.js';

const BMS = 'blur-my-shell@aunetx';

// Use the already installed compositor pipeline: it captures the actual
// backdrop and rounds the blurred output in one pass. Nesting a native blur
// inside a generic offscreen corner mask would lose the real backdrop.
export class Backdrop {
    constructor(root, settings) {
        this.life = new Lifetime();
        this.settings = settings;
        this.root = root;
        this.generation = 0;
        this.expanded = false;
        this.radius = 28;
        this.visible = root.visible;
        this.actor = new St.Widget({reactive: false, x_expand: true, y_expand: true,
            visible: this.visible,
            layout_manager: new Clutter.BinLayout()});
        root.insert_child_at_index(this.actor, 0);
        this.life.connect(Main.extensionManager, 'extension-state-changed', (_manager, extension) => {
            if (extension.uuid === BMS)
                this.connectPipeline();
        });
        this.life.connect(settings, 'changed::blur-strength', () => this.update());
        this.connectPipeline();
    }

    async connectPipeline() {
        const generation = ++this.generation;
        this.disconnectPipeline();
        if (!this.life.alive || !this.visible)
            return;
        const extension = Main.extensionManager.lookup(BMS);
        const bms = extension?.stateObj;
        if (extension?.state !== 1 || !bms?._effects_manager || !bms?._pipelines_manager)
            return;
        try {
            const {DynamicPipeline} = await import(`${extension.dir.get_uri()}/render/dynamic_surface.js`);
            if (!this.life.alive || generation !== this.generation)
                return;
            this.pipeline = new DynamicPipeline(bms._effects_manager, bms._pipelines_manager,
                'pipeline_default', {corner_radius: this.radius});
            // Let BinLayout allocate the layer. Resizing it from an allocation
            // signal would invalidate that same frame and cause repaint churn.
            const background = this.pipeline.create_actor('liquid-island-backdrop');
            background.x_expand = true;
            background.y_expand = true;
            this.actor.add_child(background);
            this.pipeline.ownsActor = true;
            this.pipeline.attach_pipeline();
            this.root.remove_style_class_name('liquid-no-blur');
            this.update();
        } catch (error) {
            if (!this.life.alive || generation !== this.generation)
                return;
            console.debug(`Liquid Island backdrop: ${error.message}`);
            this.disconnectPipeline();
        }
    }

    setVisible(visible) {
        if (this.visible === visible)
            return;
        this.visible = visible;
        this.actor.visible = visible;
        if (visible) {
            this.connectPipeline();
        } else {
            // Drop capture resources as well as unmapping the layer. A later
            // import must not reattach a backdrop to an already hidden popup.
            this.generation++;
            this.disconnectPipeline();
        }
    }

    update(expanded = this.expanded, radius = this.radius) {
        this.expanded = expanded;
        this.radius = radius;
        this.pipeline?.set_corner_radius(radius);
        let strength = 0.85;
        try {
            strength = this.settings.get_double('blur-strength');
        } catch (_) {}
        this.pipeline?.set_opacity_factor(strength, true);
    }

    disconnectPipeline() {
        this.pipeline?.destroy();
        this.pipeline = null;
        this.actor?.destroy_all_children?.();
        this.root.add_style_class_name('liquid-no-blur');
    }

    destroy() {
        this.generation++;
        this.life.destroy();
        this.disconnectPipeline();
        this.actor.destroy();
    }
}
