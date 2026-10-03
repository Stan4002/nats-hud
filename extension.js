import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SystemTelemetry} from './src/telemetry.js';
import {
    formatBytes,
    formatBytesPerSecond,
    formatDuration,
    formatLoad,
    formatPercent,
    formatTemperature
} from './src/formatters.js';
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
        this._networkHistory = [];
        const initialSnapshot = this._telemetry.readSnapshot();
        this._buildHud(initialSnapshot.cpu.cores);
        this._updateMetrics(initialSnapshot);

        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_SECONDS,
            () => {
                this._updateMetrics();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _buildHud(initialCores) {
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

        this._coreMetrics = new Map();
        this._coreColumns = [];
        this._coreGrid = new St.BoxLayout({
            style_class: 'nats-core-grid',
            x_expand: true
        });
        for (let columnIndex = 0; columnIndex < 2; columnIndex++) {
            const column = new St.BoxLayout({
                vertical: true,
                style_class: 'nats-core-column',
                x_expand: true
            });
            this._coreColumns.push(column);
            this._coreGrid.add_child(column);
        }
        this._ensureCoreMetrics(initialCores);
        this._cpuCard.body.add_child(this._coreGrid);
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

        const dataRow = new St.BoxLayout({
            style_class: 'nats-data-row',
            x_expand: true
        });

        this._networkCard = new GlassCard({
            title: 'NETWORK',
            subtitle: 'Live interface traffic',
            iconText: '⌁',
            reactive: false
        });
        this._networkCard.x_expand = true;
        const networkValues = new St.BoxLayout({
            style_class: 'nats-network-values',
            x_expand: true
        });
        this._networkDownload = new MetricValue({label: 'DOWNLOAD'});
        this._networkUpload = new MetricValue({label: 'UPLOAD'});
        for (const metric of [this._networkDownload, this._networkUpload]) {
            metric.add_style_class_name('nats-network-metric');
            metric.x_expand = true;
            networkValues.add_child(metric);
        }
        this._networkInterface = new St.Label({
            text: 'INTERFACE --',
            style_class: 'nats-network-interface',
            x_expand: true
        });
        this._networkSparkline = new SparklineLabel(this._networkHistory);
        this._networkCard.body.add_child(networkValues);
        this._networkCard.body.add_child(this._networkInterface);
        this._networkCard.body.add_child(this._networkSparkline);
        dataRow.add_child(this._networkCard);

        this._storageCard = new GlassCard({
            title: 'STORAGE',
            subtitle: 'Root filesystem',
            iconText: '▤',
            reactive: false
        });
        this._storageCard.x_expand = true;
        this._storageValue = new MetricValue({
            value: '--',
            label: 'ROOT USED'
        });
        this._storageProgress = new ProgressMetric({
            label: 'CAPACITY',
            percent: 0,
            text: '-- / --'
        });
        this._storageFree = new St.Label({
            text: 'FREE --',
            style_class: 'nats-storage-free',
            x_expand: true
        });
        this._storageCard.body.add_child(this._storageValue);
        this._storageCard.body.add_child(this._storageProgress);
        this._storageCard.body.add_child(this._storageFree);
        dataRow.add_child(this._storageCard);
        this._hud.add_child(dataRow);

        const actionsCard = new GlassCard({
            title: 'SYSTEM / ACTIONS',
            subtitle: 'Quick access to system tools',
            iconText: '⌘',
            reactive: false
        });
        const systemValues = new St.BoxLayout({
            style_class: 'nats-system-values',
            x_expand: true
        });
        this._systemMetrics = {
            uptime: new MetricValue({label: 'UPTIME'}),
            loadOne: new MetricValue({label: 'LOAD 1M'}),
            loadFive: new MetricValue({label: 'LOAD 5M'}),
            loadFifteen: new MetricValue({label: 'LOAD 15M'})
        };
        for (const metric of Object.values(this._systemMetrics)) {
            metric.add_style_class_name('nats-system-metric');
            metric.x_expand = true;
            systemValues.add_child(metric);
        }
        actionsCard.body.add_child(systemValues);

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
        this._hud.set_position(32, Main.panel.height + 12);
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

    _ensureCoreMetrics(cores) {
        const activeCoreIds = new Set();

        for (const [index, core] of cores.entries()) {
            activeCoreIds.add(core.id);

            let metric = this._coreMetrics.get(core.id);
            if (!metric) {
                metric = new ProgressMetric({
                    label: `C${core.id.replace(/^cpu/, '')}`,
                    percent: 0,
                    text: '--'
                });
                metric.add_style_class_name('nats-core-metric');
                metric.x_expand = true;
                this._coreColumns[index % this._coreColumns.length].add_child(metric);
                this._coreMetrics.set(core.id, metric);
            }

            metric.visible = true;
            metric.update(core.usagePercent, formatPercent(core.usagePercent));
        }

        for (const [coreId, metric] of this._coreMetrics) {
            if (!activeCoreIds.has(coreId))
                metric.visible = false;
        }
    }

    _updateMetrics(snapshot = null) {
        try {
            const currentSnapshot = snapshot ?? this._telemetry.readSnapshot();
            const cpuUsage = currentSnapshot.cpu.usagePercent;
            const memory = currentSnapshot.memory;
            const network = currentSnapshot.network;
            const storage = currentSnapshot.storage;

            this._cpuValue.update(formatPercent(cpuUsage));
            this._cpuValue.secondaryLabel.text =
                `CPU TEMP ${formatTemperature(currentSnapshot.temperatureCelsius)}`;
            this._cpuProgress.update(cpuUsage, formatPercent(cpuUsage));

            if (Number.isFinite(cpuUsage)) {
                this._cpuHistory.push(cpuUsage);
                if (this._cpuHistory.length > CPU_HISTORY_LIMIT)
                    this._cpuHistory.shift();
            }
            this._cpuSparkline.update(this._cpuHistory);
            this._ensureCoreMetrics(currentSnapshot.cpu.cores);

            this._networkDownload.update(
                formatBytesPerSecond(network.downloadBytesPerSecond)
            );
            this._networkUpload.update(
                formatBytesPerSecond(network.uploadBytesPerSecond)
            );
            this._networkInterface.text = network.interfaceName
                ? `INTERFACE ${network.interfaceName}`
                : 'INTERFACE --';

            const downloadRate = network.downloadBytesPerSecond;
            const uploadRate = network.uploadBytesPerSecond;
            if (Number.isFinite(downloadRate) || Number.isFinite(uploadRate)) {
                this._networkHistory.push(
                    (Number.isFinite(downloadRate) ? downloadRate : 0) +
                    (Number.isFinite(uploadRate) ? uploadRate : 0)
                );
                if (this._networkHistory.length > CPU_HISTORY_LIMIT)
                    this._networkHistory.shift();
            }
            const networkScale = Math.max(1024, ...this._networkHistory);
            this._networkSparkline.update(this._networkHistory, networkScale);

            this._storageValue.update(formatPercent(storage.usagePercent));
            this._storageProgress.update(
                storage.usagePercent,
                `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.totalBytes)}`
            );
            this._storageFree.text = `FREE ${formatBytes(storage.freeBytes)}`;

            this._memoryValue.update(formatPercent(memory.usagePercent));
            this._memoryProgress.update(
                memory.usagePercent,
                `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`
            );

            const loadAverage = currentSnapshot.loadAverage;
            this._systemMetrics.uptime.update(formatDuration(currentSnapshot.uptimeSeconds));
            this._systemMetrics.loadOne.update(formatLoad(loadAverage.oneMinute));
            this._systemMetrics.loadFive.update(formatLoad(loadAverage.fiveMinute));
            this._systemMetrics.loadFifteen.update(formatLoad(loadAverage.fifteenMinute));
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
        this._networkHistory = [];
        this._networkCard = null;
        this._networkDownload = null;
        this._networkUpload = null;
        this._networkInterface = null;
        this._networkSparkline = null;
        this._storageCard = null;
        this._storageValue = null;
        this._storageProgress = null;
        this._storageFree = null;
        this._coreMetrics = null;
        this._coreColumns = null;
        this._coreGrid = null;
        this._systemMetrics = null;
    }
}
