import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SystemTelemetry} from './src/telemetry.js';
import {formatBytes, formatPercent} from './src/formatters.js';
import {
    GlassCard,
    MetricValue,
    ProgressMetric,
    SparklineLabel
} from './src/widgets.js';
import {
    openBtop,
    openSystemMonitor,
    openFiles,
    openTerminal
} from './src/launcher.js';

const UPDATE_INTERVAL_SECONDS = 1;
const CPU_HISTORY_LIMIT = 30;

export default class NatsHudExtension extends Extension {
    enable() {
        if (this._hud)
            return;

        this._telemetry = new SystemTelemetry();
        this._cpuHistory = [];
        this._buildHud();
        this._updateMetrics();

        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_SECONDS,
            () => {
                this._updateMetrics();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _buildHud() {
        this._hud = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-hud'
        });

        const metricsRow = new St.BoxLayout({
            style_class: 'nats-metrics-row',
            x_expand: true
        });

        this._cpuCard = new GlassCard({
            title: 'CPU',
            subtitle: 'Live processor load',
            iconText: '◉'
        });
        this._cpuCard.x_expand = true;
        this._cpuValue = new MetricValue({
            value: '--',
            label: 'Processor usage'
        });
        this._cpuProgress = new ProgressMetric({
            label: 'CPU LOAD',
            percent: 0,
            text: '--'
        });
        this._cpuSparkline = new SparklineLabel(this._cpuHistory);
        this._cpuCard.body.add_child(this._cpuValue);
        this._cpuCard.body.add_child(this._cpuProgress);
        this._cpuCard.body.add_child(this._cpuSparkline);
        this._connectCardAction(this._cpuCard, openBtop);
        metricsRow.add_child(this._cpuCard);

        this._memoryCard = new GlassCard({
            title: 'MEMORY',
            subtitle: 'Live memory allocation',
            iconText: '▦'
        });
        this._memoryCard.x_expand = true;
        this._memoryValue = new MetricValue({
            value: '--',
            label: 'Memory in use'
        });
        this._memoryProgress = new ProgressMetric({
            label: 'MEMORY USED',
            percent: 0,
            text: '--'
        });
        this._memoryCard.body.add_child(this._memoryValue);
        this._memoryCard.body.add_child(this._memoryProgress);
        this._connectCardAction(this._memoryCard, openSystemMonitor);
        metricsRow.add_child(this._memoryCard);
        this._hud.add_child(metricsRow);

        const actionsCard = new GlassCard({
            title: 'SYSTEM / ACTIONS',
            subtitle: 'Quick access to system tools',
            iconText: '⌘',
            reactive: false
        });
        const actionsRow = new St.BoxLayout({
            style_class: 'nats-actions-row',
            x_expand: true
        });
        actionsRow.add_child(this._createActionButton('BTOP', openBtop));
        actionsRow.add_child(this._createActionButton('SYSTEM MONITOR', openSystemMonitor));
        actionsRow.add_child(this._createActionButton('FILES', openFiles));
        actionsRow.add_child(this._createActionButton('TERMINAL', openTerminal));
        actionsCard.body.add_child(actionsRow);
        this._hud.add_child(actionsCard);

        Main.layoutManager._backgroundGroup.add_child(this._hud);
        this._hud.set_position(32, 48);
    }

    _connectCardAction(card, action) {
        card.connect('button-press-event', () => {
            action();
            return Clutter.EVENT_STOP;
        });

        card.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_Return &&
                key !== Clutter.KEY_KP_Enter &&
                key !== Clutter.KEY_space)
                return Clutter.EVENT_PROPAGATE;

            action();
            return Clutter.EVENT_STOP;
        });
    }

    _createActionButton(label, action) {
        const button = new St.Button({
            label,
            style_class: 'nats-action-button',
            x_expand: true,
            can_focus: true
        });
        button.connect('clicked', () => action());

        return button;
    }

    _updateMetrics() {
        try {
            const snapshot = this._telemetry.readSnapshot();
            const cpuUsage = snapshot.cpu.usagePercent;
            const memory = snapshot.memory;

            this._cpuValue.update(formatPercent(cpuUsage));
            this._cpuProgress.update(cpuUsage, formatPercent(cpuUsage));

            if (Number.isFinite(cpuUsage)) {
                this._cpuHistory.push(cpuUsage);
                if (this._cpuHistory.length > CPU_HISTORY_LIMIT)
                    this._cpuHistory.shift();
            }
            this._cpuSparkline.update(this._cpuHistory);

            this._memoryValue.update(formatPercent(memory.usagePercent));
            this._memoryProgress.update(
                memory.usagePercent,
                `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`
            );
        } catch (error) {
            logError(error, 'NATS HUD: Failed to update system telemetry');
        }
    }

    disable() {
        if (this._timer !== null && this._timer !== undefined) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }

        if (this._hud) {
            this._hud.destroy();
            this._hud = null;
        }

        this._telemetry = null;
        this._cpuHistory = [];
        this._cpuCard = null;
        this._memoryCard = null;
        this._cpuValue = null;
        this._memoryValue = null;
        this._cpuProgress = null;
        this._memoryProgress = null;
        this._cpuSparkline = null;
    }
}
