import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VISIBILITY_SETTINGS = [
    ['show-cpu', 'CPU'],
    ['show-memory', 'Memory'],
    ['show-system', 'System'],
    ['show-network', 'Network'],
    ['show-storage', 'Storage'],
    ['show-activity', 'Activity'],
    ['show-actions', 'Quick actions']
];

export default class NatsHudPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const appearanceGroup = new Adw.PreferencesGroup({title: 'General'});
        const opacityRow = new Adw.ActionRow({
            title: 'Card opacity',
            subtitle: 'Adjust the translucency of HUD cards'
        });
        const opacityScale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL,
            0.20,
            0.90,
            0.01
        );
        opacityScale.set_digits(2);
        opacityScale.set_draw_value(true);
        opacityScale.set_hexpand(true);
        opacityScale.set_size_request(220, -1);
        opacityScale.set_value(settings.get_double('card-opacity'));
        opacityScale.connect('value-changed', scale => {
            settings.set_double('card-opacity', scale.get_value());
        });
        opacityRow.add_suffix(opacityScale);
        opacityRow.set_activatable_widget(opacityScale);
        appearanceGroup.add(opacityRow);
        appearanceGroup.add(this._createSwitchRow(settings, 'show-actions', 'Quick actions'));
        page.add(appearanceGroup);

        const telemetryGroup = new Adw.PreferencesGroup({title: 'Telemetry'});
        const intervalRow = new Adw.SpinRow({
            title: 'Update interval',
            subtitle: 'Seconds between telemetry updates',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_int('update-interval')
            })
        });
        intervalRow.connect('notify::value', row => {
            settings.set_int('update-interval', row.get_value());
        });
        telemetryGroup.add(intervalRow);

        for (const [key, title] of VISIBILITY_SETTINGS.slice(0, 6))
            telemetryGroup.add(this._createSwitchRow(settings, key, title));
        page.add(telemetryGroup);

        const personalGroup = new Adw.PreferencesGroup({title: 'Personalization'});
        const nameRow = new Adw.EntryRow({title: 'Greeting display name'});
        settings.bind('display-name', nameRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        personalGroup.add(nameRow);
        personalGroup.add(this._createSwitchRow(settings, 'show-daily-verse', 'Daily KJV verse'));
        page.add(personalGroup);

        window.add(page);
    }

    _createSwitchRow(settings, key, title) {
        const row = new Adw.SwitchRow({title});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);

        return row;
    }
}
