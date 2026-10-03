import St from 'gi://St';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class NatsHudExtension extends Extension {
    enable() {
        this._hud = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-hud'
        });

        this._title = new St.Label({
            text: 'NATS // SYSTEM HUD',
            style_class: 'nats-title'
        });

        this._stats = new St.Label({
            text: 'Initializing telemetry...',
            style_class: 'nats-stats'
        });

        this._hud.add_child(this._title);
        this._hud.add_child(this._stats);

        Main.layoutManager._backgroundGroup.add_child(this._hud);

        this._hud.set_position(35, 100);

        this._update();

        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            2,
            () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _update() {
        const uptime = Math.floor(GLib.get_monotonic_time() / 1000000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        this._stats.text =
            `SYSTEM ONLINE\n\n` +
            `UPTIME   ${hours}h ${minutes}m\n` +
            `SESSION  WAYLAND\n` +
            `DESKTOP  GNOME 50\n\n` +
            `CPU      i5-8250U\n` +
            `HUD      ACTIVE`;
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }

        if (this._hud) {
            this._hud.destroy();
            this._hud = null;
        }
    }
}
