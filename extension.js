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

const CPU_HISTORY_LIMIT = 30;

export default class NatsHudExtension extends Extension {
    enable() {
        if (this._hud)
            return;

        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            this._applySettings();
            if (key === 'update-interval')
                this._restartUpdateTimer();
        });
        this._telemetry = new SystemTelemetry();
        this._cpuHistory = [];
        this._networkHistory = [];
        const initialSnapshot = this._telemetry.readSnapshot();
        this._buildHud(initialSnapshot.cpu.cores);
        this._monitorChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._positionHud()
        );
        this._updateMetrics(initialSnapshot);
        this._applySettings();
        this._restartUpdateTimer();
    }

    _buildHud(initialCores) {
        this._hud = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-hud',
            reactive: false,
            track_hover: false
        });

        const metricsRow = new St.BoxLayout({
            style_class: 'nats-top-row',
            x_expand: true,
            y_expand: true
        });

        this._cpuCard = new GlassCard({
            title: 'CPU',
            subtitle: 'Live processor load',
            iconText: '◉'
        });
        this._cpuCard.add_style_class_name('nats-cpu-card');
        this._connectCardOpacity(this._cpuCard);
        this._cpuCard.x_expand = true;
        this._cpuCard.y_expand = true;
        this._cpuCard.body.y_expand = true;
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
        this._coreGrid.y_expand = true;
        this._cpuCard.body.add_child(this._coreGrid);
        this._connectCardAction(this._cpuCard, openBtop);
        metricsRow.add_child(this._cpuCard);

        this._memoryCard = new GlassCard({
            title: 'MEMORY',
            subtitle: 'Live memory allocation',
            iconText: '▦'
        });
        this._memoryCard.add_style_class_name('nats-memory-card');
        this._connectCardOpacity(this._memoryCard);
        this._memoryCard.x_expand = true;
        this._memoryCard.y_expand = true;
        this._memoryCard.body.y_expand = true;
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

        this._systemCard = new GlassCard({
            title: 'SYSTEM',
            subtitle: 'Uptime and load',
            iconText: '◌',
            reactive: false
        });
        this._systemCard.add_style_class_name('nats-system-card');
        this._systemCard.x_expand = true;
        this._systemCard.y_expand = true;
        this._systemCard.body.y_expand = true;
        const systemValues = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-system-values',
            x_expand: true,
            y_expand: true
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
        this._systemCard.body.add_child(systemValues);
        metricsRow.add_child(this._systemCard);
        this._hud.add_child(metricsRow);

        const dataRow = new St.BoxLayout({
            style_class: 'nats-middle-row',
            x_expand: true,
            y_expand: true
        });

        this._networkCard = new GlassCard({
            title: 'NETWORK',
            subtitle: 'Live interface traffic',
            iconText: '⌁',
            reactive: false
        });
        this._networkCard.add_style_class_name('nats-network-card');
        this._networkCard.x_expand = true;
        this._networkCard.y_expand = true;
        this._networkCard.body.y_expand = true;
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
        this._storageCard.add_style_class_name('nats-storage-card');
        this._storageCard.x_expand = true;
        this._storageCard.y_expand = true;
        this._storageCard.body.y_expand = true;
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

        this._powerCard = new GlassCard({
            title: 'POWER',
            subtitle: 'Reserved',
            iconText: '◍',
            reactive: false
        });
        this._powerCard.add_style_class_name('nats-power-card');
        this._powerCard.x_expand = true;
        this._powerCard.y_expand = true;
        this._powerCard.body.y_expand = true;
        this._powerCard.body.add_child(new St.Label({
            text: 'Power telemetry not active',
            style_class: 'nats-reserved-note',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        }));
        dataRow.add_child(this._powerCard);
        this._hud.add_child(dataRow);

        const lowerRow = new St.BoxLayout({
            style_class: 'nats-lower-row',
            x_expand: true,
            y_expand: true
        });

        this._activityCard = new GlassCard({
            title: 'ACTIVITY / HISTORY',
            iconText: '⌁',
            reactive: false
        });
        this._activityCard.add_style_class_name('nats-activity-card');
        this._activityCard.x_expand = true;
        this._activityCard.y_expand = true;
        this._activityCard.body.y_expand = true;
        const activityValues = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-activity-values',
            x_expand: true,
            y_expand: true
        });
        const cpuHistory = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-history-track',
            x_expand: true,
            y_expand: true
        });
        cpuHistory.add_child(new St.Label({
            text: 'CPU',
            style_class: 'nats-history-label'
        }));
        this._activityCpuSparkline = new SparklineLabel(this._cpuHistory);
        cpuHistory.add_child(this._activityCpuSparkline);

        const networkActivity = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-history-track',
            x_expand: true,
            y_expand: true
        });
        networkActivity.add_child(new St.Label({
            text: 'NETWORK',
            style_class: 'nats-history-label'
        }));
        this._activityNetworkSparkline = new SparklineLabel(this._networkHistory);
        networkActivity.add_child(this._activityNetworkSparkline);
        activityValues.add_child(cpuHistory);
        activityValues.add_child(networkActivity);
        this._activityCard.body.add_child(activityValues);
        lowerRow.add_child(this._activityCard);

        this._quickActionsCard = new GlassCard({
            title: 'QUICK ACTIONS',
            iconText: '⌘',
            reactive: false
        });
        this._quickActionsCard.add_style_class_name('nats-quick-actions-card');
        this._quickActionsCard.y_expand = true;
        this._quickActionsCard.body.y_expand = true;
        this._quickActionsCard.x_expand = false;
        const actionsGrid = new St.BoxLayout({
            style_class: 'nats-actions-grid',
            x_expand: true,
            y_expand: true
        });
        const primaryActions = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-action-column',
            x_expand: true
        });
        const secondaryActions = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-action-column',
            x_expand: true
        });
        primaryActions.add_child(this._createActionButton('BTOP', openBtop));
        primaryActions.add_child(this._createActionButton('FILES', openFiles));
        secondaryActions.add_child(this._createActionButton('SYSTEM MONITOR', openSystemMonitor));
        secondaryActions.add_child(this._createActionButton('TERMINAL', openTerminal));
        actionsGrid.add_child(primaryActions);
        actionsGrid.add_child(secondaryActions);
        this._quickActionsCard.body.add_child(actionsGrid);
        lowerRow.add_child(this._quickActionsCard);
        this._hud.add_child(lowerRow);

        Main.layoutManager._backgroundGroup.add_child(this._hud);
        this._positionHud();
    }

    _connectCardOpacity(card) {
        card.connect('enter-event', () => {
            this._setCardOpacity(card, true);
            return Clutter.EVENT_PROPAGATE;
        });
        card.connect('leave-event', () => {
            this._setCardOpacity(card, false);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _setCardOpacity(card, hovered = false) {
        if (!card)
            return;

        const opacity = Math.min(0.9, this._cardOpacity + (hovered ? 0.06 : 0));
        card.set_style(`background-color: rgba(24, 32, 43, ${opacity});`);
    }

    _applySettings() {
        this._cardOpacity = this._settings.get_double('card-opacity');

        for (const card of [
            this._cpuCard,
            this._memoryCard,
            this._systemCard,
            this._networkCard,
            this._storageCard,
            this._powerCard,
            this._activityCard,
            this._quickActionsCard
        ]) {
            this._setCardOpacity(card, card?.hover ?? false);
        }

        const visibilitySettings = [
            ['show-cpu', this._cpuCard],
            ['show-memory', this._memoryCard],
            ['show-system', this._systemCard],
            ['show-network', this._networkCard],
            ['show-storage', this._storageCard],
            ['show-power', this._powerCard],
            ['show-activity', this._activityCard],
            ['show-actions', this._quickActionsCard]
        ];

        for (const [key, actor] of visibilitySettings)
            actor.visible = this._settings.get_boolean(key);
    }

    _restartUpdateTimer() {
        if (this._timer !== null && this._timer !== undefined)
            GLib.source_remove(this._timer);

        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._settings.get_int('update-interval'),
            () => {
                this._updateMetrics();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _positionHud() {
        if (!this._hud)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const sideMargin = 20;
        const topInset = Main.panel.height + 12;
        const bottomMargin = 24;
        const width = Math.max(1, monitor.width - sideMargin * 2);
        const height = Math.max(1, monitor.height - topInset - bottomMargin);

        this._hud.set_position(monitor.x + sideMargin, monitor.y + topInset);
        this._hud.set_size(width, height);
        this._quickActionsCard.set_width(Math.min(320, Math.max(240, width * 0.25)));
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
            this._activityNetworkSparkline.update(this._networkHistory, networkScale);
            this._activityCpuSparkline.update(this._cpuHistory);

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

        if (this._monitorChangedId) {
            Main.layoutManager.disconnect(this._monitorChangedId);
            this._monitorChangedId = null;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
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
        this._activityCpuSparkline = null;
        this._activityNetworkSparkline = null;
        this._activityCard = null;
        this._quickActionsCard = null;
        this._powerCard = null;
        this._systemCard = null;
        this._settings = null;
    }
}
