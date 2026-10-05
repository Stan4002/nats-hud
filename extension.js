import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SystemTelemetry} from './src/telemetry.js';
import {AssistantClient} from './src/assistantClient.js';
import {
    readCalendarState,
    readCommsState,
    readFocusState,
    readTaskState
} from './src/assistantState.js';
import {
    formatBytes,
    formatBytesPerSecond,
    formatDuration,
    formatFrequency,
    formatLoad,
    formatPercent,
    formatTemperature,
    makeSparkline
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
const CALENDAR_DATA_PATH = `${GLib.get_home_dir()}/.local/share/nats-assistant/calendar.json`;

function compactIdentity(value) {
    if (typeof value !== 'string' || value.length === 0)
        return '--';

    return value.length > 28 ? `${value.slice(0, 25)}...` : value;
}

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
        this._memoryHistory = [];
        this._networkHistory = [];
        this._calendarState = readCalendarState();
        this._taskState = readTaskState();
        this._assistantTasksLoaded = false;
        this._assistantHome = null;
        this._assistantConnection = 'unknown';
        this._assistantVersion = null;
        this._assistantClient = new AssistantClient();
        this._commsState = readCommsState();
        this._focusState = readFocusState();
        this._calendarEvents = Array.isArray(this._calendarState?.events) ? this._calendarState.events : [];
        this._activeSection = 'control';
        this._assistantPage = 0;
        this._assistantHomeShell = null;
        this._assistantPageHost = null;
        this._assistantPagerNav = null;
        this._assistantPrevButton = null;
        this._assistantNextButton = null;
        this._assistantDot0Button = null;
        this._assistantDot1Button = null;
        this._assistantDot2Button = null;
        this._assistantPageActor = null;
        this._assistantPageIndicators = null;
        this._assistantTaskListScrollView = null;
        this._lastSnapshot = null;
        this._startupLayoutId = 0;
        this._assistantMonitor = this._setupAssistantMonitor();
        const initialSnapshot = this._telemetry.readSnapshot();
        this._lastSnapshot = initialSnapshot;
        this._buildHud(initialSnapshot.cpu.cores);
        this._monitorChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => {
                this._scheduleHudLayoutPass();
                if (this._interactiveMode)
                    this._positionInteractionPanel();
            }
        );
        this._updateMetrics(initialSnapshot);
        this._applySettings();
        this._restartUpdateTimer();
        this._interactiveMode = false;
        this._interactionPanel = null;
        this._escapeSignalId = null;
        this._scheduleHudLayoutPass();
        Main.wm.addKeybinding(
            'toggle-interactive-mode',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleInteractiveMode()
        );
    }

    _scheduleHudLayoutPass() {
        if (this._startupLayoutId !== 0)
            return;

        this._startupLayoutId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._startupLayoutId = 0;
                if (!this._hud)
                    return GLib.SOURCE_REMOVE;

                this._positionHud();
                this._positionAmbientCard();
                if (this._interactiveMode && this._interactionPanel)
                    this._positionInteractionPanel();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _setupAssistantMonitor() {
        const assistantDir = Gio.File.new_for_path(`${GLib.get_home_dir()}/.local/share/nats-assistant`);
        try {
            if (!assistantDir.query_exists(null))
                assistantDir.make_directory_with_parents(null);
        } catch (_error) {
            // Missing assistant dir is safe to ignore until the first JSON write.
        }

        try {
            const monitor = assistantDir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', (_monitor, file, _otherFile, _eventType) => {
                const fileName = file?.get_name ? file.get_name() : null;
                if (fileName === 'tasks.json') {
                    if (!this._assistantTasksLoaded) {
                        this._taskState = readTaskState();
                        this._renderAmbientEvents();
                        this._refreshInteractiveAssistantView();
                    }
                    return;
                }
                if (!fileName || !['calendar.json', 'comms.json', 'focus.json'].includes(fileName))
                    return;
                this._refreshAssistantState();
            });
            return monitor;
        } catch (_error) {
            return null;
        }
    }

    _refreshAssistantState() {
        this._calendarState = readCalendarState();
        if (!this._assistantTasksLoaded)
            this._taskState = readTaskState();
        this._commsState = readCommsState();
        this._focusState = readFocusState();
        this._calendarEvents = Array.isArray(this._calendarState?.events) ? this._calendarState.events : [];

        if (this._ambientCalendarGrid)
            this._renderAmbientCalendar(new Date());
        this._renderAmbientEvents();

        this._refreshInteractiveAssistantView();
    }

    _refreshInteractiveAssistantView() {
        if (!this._isInteractionOpen())
            return;

        if (this._activeSection === 'control' && this._assistantPage === 1)
            this._renderAssistantCurrentPage();
        else if (this._activeSection === 'control')
            this._refreshInteractiveHome();
        else if (this._activeSection === 'comms')
            this._renderInteractionSection('comms');
    }

    _assistantClientIsActive(client) {
        return client === this._assistantClient && this._hud !== null;
    }

    _setAssistantConnection(state, version = null) {
        const previous = this._assistantConnection;
        const previousVersion = this._assistantVersion;
        this._assistantConnection = state;
        if (version)
            this._assistantVersion = version;

        if (state === 'online' && (
            previous !== 'online' ||
            (version && version !== previousVersion)
        )) {
            log(`NATS HUD: assistant online${this._assistantVersion ? ` version=${this._assistantVersion}` : ''}`);
        } else if (state === 'offline' && previous !== 'offline') {
            log('NATS HUD: assistant offline');
        } else if (state === 'error' && previous !== 'error') {
            log('NATS HUD: assistant error');
        }
    }

    _handleAssistantError(client, error, pageIndex = null) {
        if (!this._assistantClientIsActive(client) || error?.kind === 'cancelled')
            return;

        const state = error?.kind === 'offline' || error?.kind === 'timeout'
            ? 'offline'
            : 'error';
        this._setAssistantConnection(state);
        if (pageIndex !== null && this._isInteractionOpen() &&
            this._activeSection === 'control' && this._assistantPage === pageIndex)
            this._renderAssistantCurrentPage();
    }

    async _checkAssistantStatus() {
        const client = this._assistantClient;
        if (!client)
            return;

        try {
            const status = await client.checkStatus();
            if (!this._assistantClientIsActive(client))
                return;
            this._setAssistantConnection('online', status.version);
        } catch (error) {
            this._handleAssistantError(client, error);
        }
    }

    async _refreshAssistantHome(pageIndex = null) {
        const client = this._assistantClient;
        if (!client)
            return;

        try {
            const home = await client.getHome();
            if (!this._assistantClientIsActive(client))
                return;
            this._assistantHome = home;
            this._setAssistantConnection('online');
            this._renderAmbientEvents();
            if (pageIndex !== null && this._isInteractionOpen() &&
                this._activeSection === 'control' && this._assistantPage === pageIndex)
                this._renderAssistantCurrentPage();
        } catch (error) {
            this._handleAssistantError(client, error, pageIndex);
        }
    }

    async _refreshAssistantTasks(pageIndex = null) {
        const client = this._assistantClient;
        if (!client)
            return;

        try {
            const tasks = await client.getTasks();
            if (!this._assistantClientIsActive(client))
                return;
            this._taskState = {updated_at: null, tasks};
            this._assistantTasksLoaded = true;
            this._setAssistantConnection('online');
            this._renderAmbientEvents();
            if (pageIndex !== null && this._isInteractionOpen() &&
                this._activeSection === 'control' && this._assistantPage === pageIndex)
                this._renderAssistantCurrentPage();
        } catch (error) {
            this._handleAssistantError(client, error, pageIndex);
        }
    }

    async _updateAssistantTask(taskId, patch) {
        const client = this._assistantClient;
        if (!client)
            return;

        try {
            const updated = await client.updateTask(taskId, patch);
            if (!this._assistantClientIsActive(client))
                return;
            const tasks = this._taskState?.tasks ?? [];
            this._taskState = {
                updated_at: null,
                tasks: tasks.map((task) => task.id === taskId ? updated : task)
            };
            this._assistantTasksLoaded = true;
            this._setAssistantConnection('online');
            log(`NATS HUD: task updated ${taskId}`);
            this._renderAmbientEvents();
            if (this._isInteractionOpen() && this._activeSection === 'control' &&
                this._assistantPage === 1)
                this._renderAssistantCurrentPage();
            await Promise.all([
                this._refreshAssistantTasks(1),
                this._refreshAssistantHome()
            ]);
        } catch (error) {
            this._handleAssistantError(client, error, 1);
        }
    }

    async _deleteAssistantTask(taskId) {
        const client = this._assistantClient;
        if (!client)
            return;

        try {
            await client.deleteTask(taskId);
            if (!this._assistantClientIsActive(client))
                return;
            this._taskState = {
                updated_at: null,
                tasks: (this._taskState?.tasks ?? []).filter((task) => task.id !== taskId)
            };
            this._assistantTasksLoaded = true;
            this._setAssistantConnection('online');
            log(`NATS HUD: task deleted ${taskId}`);
            this._renderAmbientEvents();
            if (this._isInteractionOpen() && this._activeSection === 'control' &&
                this._assistantPage === 1)
                this._renderAssistantCurrentPage();
            await Promise.all([
                this._refreshAssistantTasks(1),
                this._refreshAssistantHome()
            ]);
        } catch (error) {
            this._handleAssistantError(client, error, 1);
        }
    }

    _refreshInteractiveHome() {
        if (!this._isInteractionOpen() || this._activeSection !== 'control')
            return;

        this._renderAssistantCurrentPage();
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
            label: 'TOTAL CPU'
        });
        this._cpuProgress = new ProgressMetric({
            label: 'CPU LOAD',
            percent: 0,
            text: '--'
        });
        this._cpuSparkline = new SparklineLabel(this._cpuHistory);
        this._cpuCard.body.add_child(this._cpuValue);
        this._cpuCard.body.add_child(this._cpuProgress);
        this._cpuDetails = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-telemetry-details',
            x_expand: true
        });
        this._cpuDetailRows = {
            temperature: this._createTelemetryDetailRow('TEMP'),
            frequency: this._createTelemetryDetailRow('FREQ')
        };
        for (const detail of Object.values(this._cpuDetailRows))
            this._cpuDetails.add_child(detail.row);
        this._cpuCard.body.add_child(this._cpuDetails);
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
            label: 'USED'
        });
        this._memoryProgress = new ProgressMetric({
            label: 'MEMORY USED',
            percent: 0,
            text: '--'
        });
        this._memoryCard.body.add_child(this._memoryValue);
        this._memoryDetails = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-telemetry-details',
            x_expand: true
        });
        this._memoryDetailRows = {
            available: this._createTelemetryDetailRow('AVAILABLE')
        };
        for (const detail of Object.values(this._memoryDetailRows))
            this._memoryDetails.add_child(detail.row);
        this._memoryCard.body.add_child(this._memoryDetails);
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
        this._systemCard.body.add_child(systemValues);
        this._systemIdentity = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-telemetry-details nats-system-identity',
            x_expand: true
        });
        this._systemIdentityRows = {
            hostname: this._createTelemetryDetailRow('HOST'),
            kernel: this._createTelemetryDetailRow('KERNEL'),
            osName: this._createTelemetryDetailRow('OS'),
            architecture: this._createTelemetryDetailRow('ARCH'),
            logicalCpus: this._createTelemetryDetailRow('LOGICAL CPUs')
        };

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
        this._networkDetails = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-telemetry-details',
            x_expand: true
        });
        this._networkDetailRows = {
            rxTotal: this._createTelemetryDetailRow('RX TOTAL'),
            txTotal: this._createTelemetryDetailRow('TX TOTAL')
        };
        for (const detail of Object.values(this._networkDetailRows))
            this._networkDetails.add_child(detail.row);
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
        this._storageDetails = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-telemetry-details',
            x_expand: true
        });
        this._storageDetailRows = {
            mountPoint: this._createTelemetryDetailRow('MOUNT'),
            filesystemType: this._createTelemetryDetailRow('FILESYSTEM')
        };
        for (const detail of Object.values(this._storageDetailRows))
            this._storageDetails.add_child(detail.row);
        dataRow.add_child(this._storageCard);
        this._hud.add_child(dataRow);

        const lowerRow = new St.BoxLayout({
            vertical: true,
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
        this._activityCard.body.set_y_expand(true);
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

        const memoryActivity = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-history-track',
            x_expand: true,
            y_expand: true
        });
        memoryActivity.add_child(new St.Label({
            text: 'MEMORY',
            style_class: 'nats-history-label'
        }));
        this._activityMemorySparkline = new SparklineLabel(this._memoryHistory);
        memoryActivity.add_child(this._activityMemorySparkline);

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
        activityValues.add_child(memoryActivity);
        activityValues.add_child(networkActivity);
        this._activityPeakRows = {
            cpu: this._createTelemetryDetailRow('CPU PEAK'),
            network: this._createTelemetryDetailRow('NET PEAK')
        };
        this._activityCard.body.add_child(activityValues);
        lowerRow.add_child(this._activityCard);

        this._ambientCard = new GlassCard({
            title: 'CALENDAR',
            subtitle: 'Upcoming',
            iconText: '◷',
            reactive: false
        });
        this._ambientCard.add_style_class_name('nats-ambient-card');
        this._ambientCard.y_expand = true;
        this._ambientCard.x_expand = false;
        this._ambientCard.x_align = Clutter.ActorAlign.END;
        this._buildAmbientCard();
        this._hud.add_child(lowerRow);

        Main.layoutManager._backgroundGroup.add_child(this._hud);
        Main.layoutManager._backgroundGroup.add_child(this._ambientCard);
        this._updateAmbientMode();
        this._updateAmbientCard();
        this._positionHud();
    }

    _createTelemetryDetailRow(label) {
        const row = new St.BoxLayout({
            style_class: 'nats-telemetry-row',
            x_expand: true
        });
        row.add_child(new St.Label({
            text: label,
            style_class: 'nats-telemetry-label',
            x_expand: true
        }));
        const value = new St.Label({
            text: '--',
            style_class: 'nats-telemetry-value',
            x_align: Clutter.ActorAlign.END
        });
        row.add_child(value);
        return {row, value};
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
            this._activityCard,
            this._ambientCard
        ]) {
            this._setCardOpacity(card, card?.hover ?? false);
        }

        const visibilitySettings = [
            ['show-cpu', this._cpuCard],
            ['show-memory', this._memoryCard],
            ['show-system', this._systemCard],
            ['show-network', this._networkCard],
            ['show-storage', this._storageCard],
            ['show-activity', this._activityCard]
        ];

        for (const [key, actor] of visibilitySettings)
            actor.visible = this._settings.get_boolean(key);

        this._updateAmbientMode();
        this._scheduleHudLayoutPass();
    }

    _loadCalendarEvents() {
        const state = readCalendarState();
        return Array.isArray(state?.events) ? state.events : [];
    }

    _loadTasks() {
        const state = readTaskState();
        const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
        return tasks
            .filter((task) => task && typeof task === 'object' && !task.completed)
            .map((task) => ({
                ...task,
                title: typeof task.title === 'string' ? task.title.trim() : '',
                due: typeof task.due === 'string' ? task.due : null,
                completed: Boolean(task.completed),
                priority: typeof task.priority === 'string' ? task.priority.toLowerCase() : 'normal',
                source: typeof task.source === 'string' ? task.source : 'manual'
            }))
            .filter((task) => task.title)
            .sort((first, second) => {
                const firstTime = first.due ? Date.parse(first.due) : Number.POSITIVE_INFINITY;
                const secondTime = second.due ? Date.parse(second.due) : Number.POSITIVE_INFINITY;
                return firstTime - secondTime;
            });
    }

    _getFutureCalendarEvents() {
        return (Array.isArray(this._calendarEvents) ? this._calendarEvents : [])
            .map((event) => {
                const startValue = typeof event?.start === 'string' ? event.start : null;
                const endValue = typeof event?.end === 'string' ? event.end : null;
                const rawTimestamp = startValue ?? endValue ?? '';
                const timestamp = Date.parse(rawTimestamp);
                if (!event || typeof event.title !== 'string' || !event.title.trim() || !Number.isFinite(timestamp))
                    return null;
                return {...event, title: event.title.trim(), _timestamp: timestamp};
            })
            .filter(Boolean)
            .filter((event) => event._timestamp >= Date.now())
            .sort((first, second) => first._timestamp - second._timestamp);
    }

    _getAttentionCommsEntries() {
        const entries = Array.isArray(this._commsState?.entries) ? this._commsState.entries : [];
        return entries
            .filter((entry) => entry && typeof entry === 'object')
            .filter((entry) => {
                const state = String(entry.state ?? entry.status ?? '').toUpperCase();
                return state !== 'RESOLVED' && state !== 'MUTED';
            })
            .filter((entry) => {
                const state = String(entry.state ?? entry.status ?? '').toUpperCase();
                return state === 'WAITING_ON_ME' || state === 'FOLLOW_UP_DUE' || state === 'CRITICAL' || state === 'HIGH';
            })
            .slice(0, 2);
    }

    _renderAmbientEvents() {
        if (!this._ambientReminderList || !this._ambientMoreLabel)
            return;

        this._calendarEvents = this._calendarState?.events ?? this._loadCalendarEvents();
        const visibleCount = this._interactiveMode ? 6 : 3;
        const upcoming = this._getFutureCalendarEvents().slice(0, Math.max(visibleCount, 1));

        this._ambientReminderList.remove_all_children();
        this._ambientReminderLabels = [];

        if (upcoming.length === 0) {
            const emptyLabel = new St.Label({
                text: 'Nothing scheduled',
                style_class: 'nats-ambient-reminder',
                x_expand: true
            });
            this._ambientReminderList.add_child(emptyLabel);
            this._ambientReminderLabels.push(emptyLabel);
        } else {
            for (const item of upcoming) {
                const start = item.start ? new Date(item.start) : new Date(item.end);
                const timestampText = Number.isFinite(start.getTime())
                    ? start.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
                    : '—';
                const label = new St.Label({
                    text: `${timestampText} ${item.title}`,
                    style_class: 'nats-ambient-reminder',
                    x_expand: true
                });
                this._ambientReminderList.add_child(label);
                this._ambientReminderLabels.push(label);
            }
        }

        const futureCount = this._getFutureCalendarEvents().length;
        const moreCount = Math.max(0, futureCount - upcoming.length);
        this._ambientMoreLabel.visible = !this._interactiveMode && moreCount > 0;
        this._ambientMoreLabel.text = moreCount > 0 ? `+${moreCount} more` : '';

        if (this._assistantNextValue) {
            const nextEvent = this._getFutureCalendarEvents()[0];
            if (nextEvent) {
                const nextTime = new Date(nextEvent.start ?? nextEvent.end);
                const nextLabel = Number.isFinite(nextTime.getTime())
                    ? nextTime.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
                    : '—';
                const nowTime = Date.now();
                const diffMinutes = Math.max(0, Math.round((nextTime.getTime() - nowTime) / 60000));
                this._assistantNextValue.text = `${nextLabel} ${nextEvent.title}`;
                this._assistantNextMeta.text = diffMinutes > 0 ? `in ${diffMinutes >= 60 ? `${Math.floor(diffMinutes / 60)}h ${diffMinutes % 60}m` : `${diffMinutes}m`}` : 'now';
            } else {
                this._assistantNextValue.text = 'Nothing scheduled';
                this._assistantNextMeta.text = '';
            }
        }

        if (this._assistantNowValue) {
            const focus = this._focusState?.focus;
            const title = typeof focus?.title === 'string' && focus.title.trim()
                ? focus.title.trim()
                : typeof focus?.name === 'string' && focus.name.trim()
                    ? focus.name.trim()
                    : null;
            this._assistantNowValue.text = title || 'No active focus';
        }

        if (this._assistantTaskList) {
            const tasks = Array.isArray(this._assistantHome?.tasks?.items)
                ? this._assistantHome.tasks.items
                : this._taskState?.tasks?.filter((task) => task && !task.completed) ?? this._loadTasks();
            this._assistantTaskList.remove_all_children();
            const visibleTasks = tasks.slice(0, 3);

            if (visibleTasks.length === 0) {
                const emptyLabel = new St.Label({
                    text: this._assistantConnection === 'offline' &&
                        !this._assistantHome && !this._assistantTasksLoaded
                        ? 'Assistant offline'
                        : 'No pending tasks',
                    style_class: 'nats-ambient-reminder',
                    x_expand: true
                });
                this._assistantTaskList.add_child(emptyLabel);
            } else {
                for (const task of visibleTasks) {
                    const taskLabel = new St.Label({
                        text: `□ ${task.title}`,
                        style_class: 'nats-ambient-reminder',
                        x_expand: true
                    });
                    this._assistantTaskList.add_child(taskLabel);
                }
            }

            if (this._assistantTaskMore) {
                const totalTasks = Number.isInteger(this._assistantHome?.tasks?.pending)
                    ? this._assistantHome.tasks.pending
                    : tasks.length;
                const extraCount = Math.max(0, totalTasks - visibleTasks.length);
                this._assistantTaskMore.visible = extraCount > 0;
                this._assistantTaskMore.text = extraCount > 0 ? `+${extraCount} more` : '';
            }
        }

        if (this._assistantCommsValue) {
            const attentionEntries = this._getAttentionCommsEntries();
            this._assistantCommsValue.text = attentionEntries.length > 0
                ? attentionEntries.map((entry) => entry.contact || entry.name || 'Conversation').slice(0, 2).join('\n')
                : 'Nothing needs attention';
        }
    }

    _buildAmbientCard() {
        const body = this._ambientCard.body;

        this._ambientDateHeader = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-ambient-now',
            x_expand: true
        });
        this._ambientDateTitle = new St.Label({
            text: 'TODAY',
            style_class: 'nats-ambient-section-title'
        });
        this._ambientDateValue = new St.Label({
            text: '',
            style_class: 'nats-ambient-date-value'
        });
        this._ambientDateHeader.add_child(this._ambientDateTitle);
        this._ambientDateHeader.add_child(this._ambientDateValue);
        body.add_child(this._ambientDateHeader);

        this._assistantNowHeading = new St.Label({
            text: 'NOW',
            style_class: 'nats-ambient-section-title'
        });
        this._assistantNowValue = new St.Label({
            text: 'No active focus',
            style_class: 'nats-ambient-reminder'
        });
        body.add_child(this._assistantNowHeading);
        body.add_child(this._assistantNowValue);

        this._assistantNextHeading = new St.Label({
            text: 'NEXT',
            style_class: 'nats-ambient-section-title'
        });
        this._assistantNextValue = new St.Label({
            text: 'Nothing scheduled',
            style_class: 'nats-ambient-reminder'
        });
        this._assistantNextMeta = new St.Label({
            text: '',
            style_class: 'nats-ambient-more'
        });
        body.add_child(this._assistantNextHeading);
        body.add_child(this._assistantNextValue);
        body.add_child(this._assistantNextMeta);

        this._ambientReminderHeading = new St.Label({
            text: 'UPCOMING',
            style_class: 'nats-ambient-section-title'
        });
        body.add_child(this._ambientReminderHeading);
        this._ambientReminderList = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-ambient-reminder-list',
            x_expand: true
        });
        body.add_child(this._ambientReminderList);
        this._ambientMoreLabel = new St.Label({
            text: '',
            style_class: 'nats-ambient-more'
        });
        body.add_child(this._ambientMoreLabel);

        this._assistantCalendarHeading = new St.Label({
            text: 'CALENDAR',
            style_class: 'nats-ambient-section-title'
        });
        body.add_child(this._assistantCalendarHeading);
        this._ambientCalendarHeading = new St.BoxLayout({
            style_class: 'nats-ambient-calendar-heading',
            x_expand: true
        });
        this._ambientCalendarTitle = new St.Label({
            text: '',
            style_class: 'nats-ambient-section-title',
            x_expand: true
        });
        this._ambientCalendarHeading.add_child(this._ambientCalendarTitle);
        body.add_child(this._ambientCalendarHeading);

        this._ambientCalendar = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-ambient-calendar',
            x_expand: true
        });
        this._ambientWeekdays = new St.BoxLayout({
            style_class: 'nats-ambient-calendar-row',
            x_expand: true
        });
        for (const day of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
            this._ambientWeekdays.add_child(new St.Label({
                text: day,
                style_class: 'nats-ambient-weekday',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER
            }));
        }
        this._ambientCalendar.add_child(this._ambientWeekdays);
        this._ambientCalendarGrid = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-ambient-calendar-grid',
            x_expand: true
        });
        this._ambientCalendar.add_child(this._ambientCalendarGrid);
        body.add_child(this._ambientCalendar);

        this._assistantTaskHeading = new St.Label({
            text: 'TASKS',
            style_class: 'nats-ambient-section-title'
        });
        this._assistantTaskList = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-ambient-reminder-list',
            x_expand: true
        });
        this._assistantTaskMore = new St.Label({
            text: '',
            style_class: 'nats-ambient-more'
        });
        body.add_child(this._assistantTaskHeading);
        body.add_child(this._assistantTaskList);
        body.add_child(this._assistantTaskMore);

        this._assistantCommsHeading = new St.Label({
            text: 'COMMS',
            style_class: 'nats-ambient-section-title'
        });
        this._assistantCommsValue = new St.Label({
            text: 'No active comms',
            style_class: 'nats-ambient-reminder'
        });
        body.add_child(this._assistantCommsHeading);
        body.add_child(this._assistantCommsValue);

        this._ambientCalendarDateKey = null;
        this._renderAmbientCalendar(new Date());
        this._renderAmbientEvents();
    }

    _renderAmbientCalendar(now) {
        if (!this._ambientCalendarGrid || !this._ambientCalendarTitle)
            return;

        const date = now instanceof Date
            ? now
            : new Date(now.get_year(), now.get_month() - 1, now.get_day());
        const year = date.getFullYear();
        const month = date.getMonth();
        this._ambientCalendarTitle.text = GLib.DateTime
            .new_local(year, month + 1, 1, 0, 0, 0)
            .format('%B %Y');
        this._ambientCalendarGrid.remove_all_children();

        const eventDates = new Set(
            (this._calendarEvents || [])
                .map((event) => {
                    const raw = event?.start ?? event?.end ?? '';
                    const parsed = Date.parse(raw);
                    if (!Number.isFinite(parsed))
                        return null;
                    const date = new Date(parsed);
                    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
                })
                .filter(Boolean)
        );

        const firstDayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const cellCount = Math.ceil((firstDayOffset + daysInMonth) / 7) * 7;
        for (let cell = 0; cell < cellCount; cell += 7) {
            const row = new St.BoxLayout({
                style_class: 'nats-ambient-calendar-row',
                x_expand: true
            });
            for (let column = 0; column < 7; column++) {
                const day = cell + column - firstDayOffset + 1;
                const isDate = day >= 1 && day <= daysInMonth;
                const isToday = isDate && day === date.getDate();
                const cellBox = new St.BoxLayout({
                    vertical: true,
                    style_class: isToday ? 'nats-ambient-calendar-day nats-ambient-today' : 'nats-ambient-calendar-day',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER
                });
                if (isDate) {
                    const label = new St.Label({
                        text: String(day),
                        style_class: 'nats-ambient-calendar-day-label',
                        x_expand: true,
                        x_align: Clutter.ActorAlign.CENTER
                    });
                    cellBox.add_child(label);
                    const dateKey = `${year}-${month}-${day}`;
                    if (eventDates.has(dateKey)) {
                        const marker = new St.Label({
                            text: '•',
                            style_class: 'nats-ambient-calendar-marker',
                            x_align: Clutter.ActorAlign.CENTER
                        });
                        cellBox.add_child(marker);
                    }
                }
                row.add_child(cellBox);
            }
            this._ambientCalendarGrid.add_child(row);
        }
    }

    _updateAmbientCard() {
        if (this._ambientDateValue) {
            const now = GLib.DateTime.new_now_local();
            this._ambientDateValue.text = `${now.format('%A')} · ${now.format('%d %B')} · ${now.format('%H:%M')}`;
        }

        if (!this._ambientCalendarGrid)
            return;

        this._renderAmbientCalendar(new Date());
        this._renderAmbientEvents();
    }

    _updateAmbientMode() {
        if (!this._ambientCard || !this._ambientReminderLabels)
            return;

        this._ambientCard.remove_style_class_name('nats-ambient-interactive');
        if (this._interactiveMode)
            this._ambientCard.add_style_class_name('nats-ambient-interactive');

        this._renderAmbientEvents();
        this._ambientReminderLabels.forEach((label, index) => {
            label.visible = this._interactiveMode || index < 2;
        });
        this._ambientMoreLabel.visible = !this._interactiveMode && this._calendarEvents.length > 2;
        this._ambientMoreLabel.text = this._calendarEvents.length > 2 ? `+${this._calendarEvents.length - 2} more` : '';
        this._positionAmbientCard();
        this._ambientCard.queue_relayout();
    }

    _positionAmbientCard() {
        if (!this._ambientCard)
            return;

        const {x, y, width, height} = this._getAssistantRailGeometry();
        this._ambientCard.set_position(x, y);
        this._ambientCard.set_width(width);
        this._ambientCard.set_height(height);
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

    _getAssistantRailGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return {x: 0, y: 0, width: 360, height: 320};

        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.primaryIndex
        );
        const sideMargin = 20;
        const verticalInset = 8;
        const usableWidth = Math.max(1, workArea.width - sideMargin * 2);
        const width = Math.round(usableWidth * 0.27);
        const height = Math.max(1, workArea.height - verticalInset * 2);
        return {
            x: workArea.x + sideMargin + usableWidth - width,
            y: workArea.y + verticalInset,
            width,
            height
        };
    }

    _getInteractionPanelGeometry() {
        return this._getAssistantRailGeometry();
    }

    _positionHud() {
        if (!this._hud)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.primaryIndex
        );
        const railGeometry = this._getAssistantRailGeometry();
        const sideMargin = 20;
        const gap = 12;
        const x = workArea.x + sideMargin;
        const width = Math.max(1, railGeometry.x - x - gap);

        this._hud.set_position(x, railGeometry.y);
        this._hud.set_size(width, railGeometry.height);
        this._positionAmbientCard();
    }

    _isInteractionOpen() {
        const panel = this._interactionPanel;
        if (!panel)
            return false;

        const parent = panel.get_parent();
        return this._interactiveMode === true && parent === Main.uiGroup && panel.visible;
    }

    _toggleInteractiveMode() {
        if (this._isInteractionOpen())
            this._hideInteractionPanel();
        else
            this._showInteractionPanel();
    }

    _updateActiveInteractionView(snapshot) {
        if (!this._interactionPanel || !this._activeSection)
            return;

        switch (this._activeSection) {
        case 'cpu':
            this._updateCpuInteractionView(snapshot);
            break;
        case 'memory':
            this._updateMemoryInteractionView(snapshot);
            break;
        case 'network':
            this._updateNetworkInteractionView(snapshot);
            break;
        case 'storage':
            this._updateStorageInteractionView(snapshot);
            break;
        case 'system':
            this._updateSystemInteractionView(snapshot);
            break;
        case 'activity':
            this._updateActivityInteractionView(snapshot);
            break;
        }
    }

    _updateCpuInteractionView(snapshot) {
        const refs = this._cpuInteractionRefs;
        if (!refs)
            return;

        const cpu = snapshot?.cpu ?? {};
        const usagePercent = Number.isFinite(cpu.usagePercent) ? cpu.usagePercent : null;
        const temperature = Number.isFinite(snapshot?.temperatureCelsius)
            ? snapshot.temperatureCelsius
            : null;
        const loadAverage = snapshot?.loadAverage ?? {};

        if (refs.usageLabel)
            refs.usageLabel.text = usagePercent !== null
                ? formatPercent(usagePercent)
                : '--';
        if (refs.tempLabel)
            refs.tempLabel.text = temperature !== null
                ? formatTemperature(temperature)
                : '--';
        if (refs.loadLabel) {
            refs.loadLabel.text = [
                formatLoad(loadAverage.oneMinute),
                formatLoad(loadAverage.fiveMinute),
                formatLoad(loadAverage.fifteenMinute)
            ].join('  ');
        }
        if (refs.historyLabel) {
            refs.historyLabel.text = this._cpuHistory.length > 0
                ? makeSparkline(this._cpuHistory, Math.max(100, ...this._cpuHistory))
                : '▁▂▃▄▅▆▇█';
        }

        const cores = Array.isArray(cpu.cores) ? cpu.cores : [];
        refs.coreRows?.forEach((row, index) => {
            const core = cores[index];
            if (!core)
                return;

            row.usage = Number.isFinite(core.usagePercent) ? core.usagePercent : 0;
            if (row.value)
                row.value.text = formatPercent(row.usage);
            this._updateCpuCoreBarGeometry(row);
        });
    }

    _updateCpuCoreBarGeometry(row) {
        if (!row?.track || !row.fill)
            return;

        const usage = Number.isFinite(row.usage)
            ? Math.max(0, Math.min(100, row.usage))
            : 0;
        row.fill.set_width((row.track.get_width() * usage) / 100);
    }

    _updateMemoryInteractionView(snapshot) {
        const refs = this._memoryInteractionRefs;
        if (!refs)
            return;

        const memory = snapshot?.memory ?? {};
        const used = Number.isFinite(memory.usedBytes) ? memory.usedBytes : null;
        const total = Number.isFinite(memory.totalBytes) ? memory.totalBytes : null;
        const available = Number.isFinite(memory.availableBytes) ? memory.availableBytes : null;
        const usagePercent = Number.isFinite(memory.usagePercent)
            ? memory.usagePercent
            : null;

        if (refs.usageLabel)
            refs.usageLabel.text = usagePercent !== null
                ? formatPercent(usagePercent)
                : '--';
        if (refs.usedLabel)
            refs.usedLabel.text = used !== null && total !== null
                ? `${formatBytes(used)} / ${formatBytes(total)}`
                : '--';
        if (refs.availableLabel)
            refs.availableLabel.text = available !== null
                ? formatBytes(available)
                : '--';
        if (refs.cachedLabel)
            refs.cachedLabel.text = formatBytes(memory.cachedBytes);
        if (refs.swapLabel)
            refs.swapLabel.text = Number.isFinite(memory.swapUsedBytes) &&
                Number.isFinite(memory.swapTotalBytes)
                ? `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}`
                : '--';

        refs.usagePercent = usagePercent;
        this._updateMemoryBarGeometry(refs);
    }

    _updateMemoryBarGeometry(refs) {
        if (!refs?.memoryTrack || !refs.memoryFill)
            return;

        const usage = Number.isFinite(refs.usagePercent)
            ? Math.max(0, Math.min(100, refs.usagePercent))
            : 0;
        refs.memoryFill.set_width((refs.memoryTrack.get_width() * usage) / 100);
    }

    _updateNetworkInteractionView(snapshot) {
        const refs = this._networkInteractionRefs;
        if (!refs)
            return;

        const network = snapshot?.network ?? {};
        if (refs.interfaceLabel)
            refs.interfaceLabel.text = network.interfaceName ?? '--';
        if (refs.downloadLabel)
            refs.downloadLabel.text = formatBytesPerSecond(network.downloadBytesPerSecond);
        if (refs.uploadLabel)
            refs.uploadLabel.text = formatBytesPerSecond(network.uploadBytesPerSecond);
        if (refs.rxTotalLabel)
            refs.rxTotalLabel.text = formatBytes(network.rxTotalBytes);
        if (refs.txTotalLabel)
            refs.txTotalLabel.text = formatBytes(network.txTotalBytes);
    }

    _updateStorageInteractionView(snapshot) {
        const refs = this._storageInteractionRefs;
        if (!refs)
            return;

        const storage = snapshot?.storage ?? {};
        const used = Number.isFinite(storage.usedBytes) ? storage.usedBytes : null;
        const total = Number.isFinite(storage.totalBytes) ? storage.totalBytes : null;
        const free = Number.isFinite(storage.freeBytes) ? storage.freeBytes : null;
        const usagePercent = Number.isFinite(storage.usagePercent)
            ? storage.usagePercent
            : null;

        if (refs.usedLabel)
            refs.usedLabel.text = used !== null && total !== null
                ? `${formatBytes(used)} / ${formatBytes(total)}`
                : '--';
        if (refs.percentLabel)
            refs.percentLabel.text = formatPercent(usagePercent);
        if (refs.availableLabel)
            refs.availableLabel.text = free !== null ? formatBytes(free) : '--';

        refs.usagePercent = usagePercent;
        this._updateStorageBarGeometry(refs);
    }

    _updateStorageBarGeometry(refs) {
        if (!refs?.storageTrack || !refs.storageFill)
            return;

        const usage = Number.isFinite(refs.usagePercent)
            ? Math.max(0, Math.min(100, refs.usagePercent))
            : 0;
        refs.storageFill.set_width((refs.storageTrack.get_width() * usage) / 100);
    }

    _updateSystemInteractionView(snapshot) {
        const refs = this._systemInteractionRefs;
        if (!refs)
            return;

        if (refs.uptimeLabel)
            refs.uptimeLabel.text = formatDuration(snapshot?.uptimeSeconds);

        const loadAverage = snapshot?.loadAverage ?? {};
        if (refs.loadLabel) {
            refs.loadLabel.text = [
                formatLoad(loadAverage.oneMinute),
                formatLoad(loadAverage.fiveMinute),
                formatLoad(loadAverage.fifteenMinute)
            ].join(' / ');
        }

        if (refs.coresLabel) {
            const logicalCpuCount = snapshot?.cpu?.logicalCpuCount;
            refs.coresLabel.text = Number.isFinite(logicalCpuCount)
                ? String(logicalCpuCount)
                : '--';
        }
        const system = snapshot?.system ?? {};
        for (const [key, value] of Object.entries({
            hostname: system.hostname,
            kernel: system.kernelRelease,
            osName: system.osName,
            architecture: system.architecture
        })) {
            if (refs.identity?.[key])
                refs.identity[key].text = compactIdentity(value);
        }
    }

    _updateActivityInteractionView(snapshot) {
        const refs = this._activityInteractionRefs;
        if (!refs)
            return;

        refs.cpuHistory?.update(
            this._cpuHistory,
            Math.max(100, ...this._cpuHistory)
        );
        refs.networkHistory?.update(
            this._networkHistory,
            Math.max(1024, ...this._networkHistory)
        );
        refs.memoryHistory?.update(
            this._memoryHistory,
            Math.max(100, ...this._memoryHistory)
        );

        const loadAverage = snapshot?.loadAverage ?? {};
        if (refs.loadLabel) {
            refs.loadLabel.text = [
                formatLoad(loadAverage.oneMinute),
                formatLoad(loadAverage.fiveMinute),
                formatLoad(loadAverage.fifteenMinute)
            ].join(' / ');
        }
        if (refs.cpuPeakLabel)
            refs.cpuPeakLabel.text = this._cpuHistory.length > 0
                ? formatPercent(Math.max(...this._cpuHistory))
                : '--';
        if (refs.networkPeakLabel)
            refs.networkPeakLabel.text = this._networkHistory.length > 0
                ? formatBytesPerSecond(Math.max(...this._networkHistory))
                : '--';
    }

    _updateInteractionHeader(title) {
        if (this._interactionHeader)
            this._interactionHeader.text = title;
    }

    _buildInteractionPanel() {
        if (this._interactionPanel)
            return this._interactionPanel;

        const panel = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
            style_class: 'nats-interaction-panel',
            x_expand: true,
            y_expand: true
        });

        this._interactionHeader = null;
        this._interactionToolbar = new St.BoxLayout({
            style_class: 'nats-interaction-toolbar',
            x_expand: true,
            visible: false
        });
        this._interactionBackButton = new St.Button({
            label: 'BACK',
            style_class: 'nats-interaction-button nats-interaction-back',
            can_focus: true
        });
        this._interactionBackButton.connect('clicked', () =>
            this._setInteractionSection('control')
        );
        this._interactionToolbar.add_child(this._interactionBackButton);
        panel.add_child(this._interactionToolbar);

        this._interactionScrollView = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true
        });
        this._interactionScrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._interactionContent = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-content',
            x_expand: true,
            y_expand: true
        });
        this._interactionScrollView.add_child(this._interactionContent);
        panel.add_child(this._interactionScrollView);

        this._interactionFooter = new St.BoxLayout({
            style_class: 'nats-interaction-footer',
            x_expand: true
        });
        panel.add_child(this._interactionFooter);

        this._interactionPanel = panel;
        this._renderInteractionSection(this._activeSection || 'control');
        return panel;
    }

    _clearInteractionContent() {
        this._cpuInteractionRefs = null;
        this._memoryInteractionRefs = null;
        this._networkInteractionRefs = null;
        this._storageInteractionRefs = null;
        this._systemInteractionRefs = null;
        this._activityInteractionRefs = null;
        this._commsInteractionRefs = null;
        this._assistantPageActor = null;
        this._assistantPageIndicators = null;
        this._assistantHomeShell = null;
        this._assistantPageHost = null;
        this._assistantPagerNav = null;
        this._assistantPrevButton = null;
        this._assistantNextButton = null;
        this._assistantDot0Button = null;
        this._assistantDot1Button = null;
        this._assistantTaskListScrollView = null;
        for (const child of this._interactionContent?.get_children() ?? []) {
            this._interactionContent.remove_child(child);
            child.destroy();
        }
        for (const child of this._interactionFooter?.get_children() ?? []) {
            this._interactionFooter.remove_child(child);
            child.destroy();
        }
    }

    _renderInteractionSection(section) {
        const normalizedSection = ['cpu', 'memory', 'network', 'storage', 'system', 'activity', 'comms'].includes(section)
            ? section
            : 'control';
        this._activeSection = normalizedSection;

        if (!this._interactionPanel)
            return;

        this._interactionToolbar.visible = normalizedSection !== 'control';
        this._interactionScrollView.set_policy(
            St.PolicyType.NEVER,
            normalizedSection === 'control' ? St.PolicyType.NEVER : St.PolicyType.AUTOMATIC
        );
        this._updateInteractionHeader(
            normalizedSection === 'cpu'
                ? 'CPU'
                : normalizedSection === 'memory'
                    ? 'MEMORY'
                    : normalizedSection === 'network'
                        ? 'NETWORK'
                        : normalizedSection === 'storage'
                            ? 'STORAGE'
                            : normalizedSection === 'system'
                                ? 'SYSTEM'
                                : normalizedSection === 'activity'
                                    ? 'ACTIVITY'
                                    : normalizedSection === 'comms'
                                        ? 'COMMS'
                                        : 'SYSTEM'
        );

        this._clearInteractionContent();

        if (normalizedSection === 'control') {
            this._buildControlView();
            return;
        }

        if (normalizedSection === 'cpu') {
            this._buildCpuView();
            return;
        }

        if (normalizedSection === 'memory') {
            this._buildMemoryView();
            return;
        }

        if (normalizedSection === 'network') {
            this._buildNetworkView();
            return;
        }

        if (normalizedSection === 'storage') {
            this._buildStorageView();
            return;
        }

        if (normalizedSection === 'system') {
            this._buildSystemView();
            return;
        }

        if (normalizedSection === 'activity') {
            this._buildActivityView();
            return;
        }

        if (normalizedSection === 'comms') {
            this._buildCommsView();
            return;
        }
    }

    _setInteractionSection(section) {
        this._renderInteractionSection(section);
        log(`NATS HUD: active section ${this._activeSection.toUpperCase()}`);
    }

    _renderControlSection() {
        this._buildControlView();
    }

    _buildControlView() {
        if (this._assistantHomeShell) {
            this._renderAssistantCurrentPage();
            return;
        }

        this._assistantHomeShell = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-assistant-home-shell',
            x_expand: true,
            y_expand: true
        });
        this._assistantPageHost = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-assistant-page-host',
            x_expand: true,
            y_expand: true
        });
        this._assistantPagerNav = new St.BoxLayout({
            style_class: 'nats-page-nav',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._assistantPageIndicators = new St.BoxLayout({
            style_class: 'nats-page-indicators',
            x_align: Clutter.ActorAlign.CENTER
        });

        this._assistantPrevButton = new St.Button({
            label: '‹',
            style_class: 'nats-page-arrow',
            can_focus: true
        });
        this._assistantPrevButton.connect('clicked', () => {
            this._setAssistantPage(this._assistantPage - 1);
        });
        this._assistantNextButton = new St.Button({
            label: '›',
            style_class: 'nats-page-arrow',
            can_focus: true
        });
        this._assistantNextButton.connect('clicked', () => {
            this._setAssistantPage(this._assistantPage + 1);
        });

        this._assistantDot0Button = new St.Button({
            label: '○',
            style_class: 'nats-page-dot',
            can_focus: true
        });
        this._assistantDot0Button.connect('clicked', () => {
            this._setAssistantPage(0);
        });
        this._assistantDot1Button = new St.Button({
            label: '○',
            style_class: 'nats-page-dot',
            can_focus: true
        });
        this._assistantDot1Button.connect('clicked', () => {
            this._setAssistantPage(1);
        });
        this._assistantDot2Button = new St.Button({
            label: '○',
            style_class: 'nats-page-dot',
            can_focus: true
        });
        this._assistantDot2Button.connect('clicked', () => {
            this._setAssistantPage(2);
        });

        this._assistantPageIndicators.add_child(this._assistantDot0Button);
        this._assistantPageIndicators.add_child(this._assistantDot1Button);
        this._assistantPageIndicators.add_child(this._assistantDot2Button);
        this._assistantPagerNav.add_child(this._assistantPrevButton);
        this._assistantPagerNav.add_child(this._assistantPageIndicators);
        this._assistantPagerNav.add_child(this._assistantNextButton);
        this._assistantHomeShell.add_child(this._assistantPageHost);
        this._assistantHomeShell.add_child(this._assistantPagerNav);
        this._interactionContent.add_child(this._assistantHomeShell);

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-footer',
            x_expand: true
        });
        const closeButton = new St.Button({
            label: '×',
            style_class: 'nats-interaction-close',
            can_focus: true
        });
        closeButton.connect('clicked', () => this._hideInteractionPanel());
        footerRow.add_child(new St.Widget({x_expand: true}));
        footerRow.add_child(closeButton);
        this._interactionFooter.add_child(footerRow);
        this._renderAssistantCurrentPage();
        this._updateAssistantPagerControls();
    }

    _setAssistantPage(index) {
        const next = Math.max(0, Math.min(2, index));
        this._assistantPage = next;
        this._renderAssistantCurrentPage();
        this._updateAssistantPagerControls();
        if (next === 0) {
            this._refreshAssistantHome(0);
        } else if (next === 1) {
            this._refreshAssistantTasks(1);
            this._refreshAssistantHome(1);
        }
    }

    _renderAssistantCurrentPage() {
        if (!this._assistantPageHost)
            return;

        this._assistantPageActor = null;
        this._assistantTaskListScrollView = null;
        for (const child of this._assistantPageHost.get_children()) {
            this._assistantPageHost.remove_child(child);
            child.destroy();
        }

        let page;
        switch (this._assistantPage) {
        case 1:
            page = this._buildTasksPage();
            break;
        case 2:
            page = this._buildAssistantPage();
            break;
        default:
            this._assistantPage = 0;
            page = this._buildTodayPage();
            break;
        }
        this._assistantPageHost.add_child(page);
    }

    _createAssistantPage() {
        const page = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-assistant-page',
            x_expand: true,
            y_expand: true
        });
        this._assistantPageActor = page;
        return page;
    }

    _createAssistantSectionTitle(text) {
        return new St.Label({
            text,
            style_class: 'nats-interaction-group-title'
        });
    }

    _addAssistantPageRow(page, text, accent = false) {
        const row = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        row.add_child(new St.Label({
            text,
            style_class: accent
                ? 'nats-interaction-stat-value nats-acc-system'
                : 'nats-ambient-reminder',
            x_expand: true
        }));
        page.add_child(row);
    }

    _updateAssistantPagerControls() {
        if (!this._assistantPrevButton || !this._assistantNextButton ||
            !this._assistantDot0Button || !this._assistantDot1Button ||
            !this._assistantDot2Button)
            return;

        const previousEnabled = this._assistantPage > 0;
        const nextEnabled = this._assistantPage < 2;
        this._assistantPrevButton.reactive = previousEnabled;
        this._assistantPrevButton.can_focus = previousEnabled;
        this._assistantPrevButton.opacity = previousEnabled ? 255 : 90;
        this._assistantNextButton.reactive = nextEnabled;
        this._assistantNextButton.can_focus = nextEnabled;
        this._assistantNextButton.opacity = nextEnabled ? 255 : 90;

        for (const [button, page] of [
            [this._assistantDot0Button, 0],
            [this._assistantDot1Button, 1],
            [this._assistantDot2Button, 2]
        ]) {
            const active = page === this._assistantPage;
            button.label = active ? '●' : '○';
            button.style_class = active
                ? 'nats-page-dot nats-page-dot-active'
                : 'nats-page-dot';
        }
    }

    _buildTodayPage() {
        const page = this._createAssistantPage();
        const now = GLib.DateTime.new_now_local();
        const today = new Date();
        const section = (title) => page.add_child(this._createAssistantSectionTitle(title));
        const futureEvents = this._getFutureCalendarEvents();
        const nextEvent = futureEvents[0] ?? null;
        const focus = this._focusState?.focus;
        const focusTitle = typeof focus?.title === 'string' && focus.title.trim()
            ? focus.title.trim()
            : typeof focus?.name === 'string' && focus.name.trim()
                ? focus.name.trim()
                : 'No active focus';

        page.add_child(this._createAssistantSectionTitle('TODAY'));
        this._addAssistantPageRow(page, `${now.format('%A')} · ${now.format('%d %B')} · ${now.format('%H:%M')}`, true);
        section('NOW');
        this._addAssistantPageRow(page, focusTitle);
        section('NEXT');
        if (nextEvent) {
            const date = new Date(nextEvent.start ?? nextEvent.end);
            const time = Number.isFinite(date.getTime())
                ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
                : '—';
            this._addAssistantPageRow(page, `${time} ${nextEvent.title}`, true);
        } else {
            this._addAssistantPageRow(page, 'Nothing scheduled');
        }
        section('UPCOMING');
        const upcoming = futureEvents.slice(1, 3);
        if (upcoming.length > 0) {
            for (const event of upcoming) {
                const date = new Date(event.start ?? event.end);
                const time = Number.isFinite(date.getTime())
                    ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
                    : '—';
                this._addAssistantPageRow(page, `${time} ${event.title}`);
            }
        } else {
            this._addAssistantPageRow(page, nextEvent ? 'Nothing else scheduled' : 'Nothing scheduled');
        }

        section('CALENDAR');
        const calendar = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-calendar',
            x_expand: true
        });
        const monthHeader = new St.BoxLayout({
            style_class: 'nats-calendar-header',
            x_expand: true
        });
        monthHeader.add_child(new St.Label({
            text: now.format('%B %Y').toUpperCase(),
            style_class: 'nats-calendar-month',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER
        }));
        calendar.add_child(monthHeader);
        const weekdayRow = new St.BoxLayout({
            style_class: 'nats-calendar-weekdays',
            x_expand: true
        });
        for (const weekday of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
            weekdayRow.add_child(new St.Label({
                text: weekday,
                style_class: 'nats-calendar-weekday',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER
            }));
        }
        calendar.add_child(weekdayRow);
        const calendarGrid = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-calendar-grid',
            x_expand: true
        });

        const eventDates = new Set((this._calendarEvents || []).map((event) => {
            const parsed = Date.parse(event?.start ?? event?.end ?? '');
            if (!Number.isFinite(parsed))
                return null;
            const date = new Date(parsed);
            return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        }).filter(Boolean));
        const year = today.getFullYear();
        const month = today.getMonth();
        const firstDayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const cellCount = Math.ceil((firstDayOffset + daysInMonth) / 7) * 7;
        for (let cell = 0; cell < cellCount; cell += 7) {
            const row = new St.BoxLayout({
                style_class: 'nats-calendar-row',
                x_expand: true
            });
            for (let column = 0; column < 7; column++) {
                const day = cell + column - firstDayOffset + 1;
                if (day < 1 || day > daysInMonth) {
                    row.add_child(new St.BoxLayout({
                        style_class: 'nats-calendar-day',
                        x_expand: true
                    }));
                    continue;
                }
                const dayCell = new St.BoxLayout({
                    vertical: true,
                    style_class: day === today.getDate()
                        ? 'nats-calendar-day nats-calendar-today'
                        : 'nats-calendar-day',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER
                });
                dayCell.add_child(new St.Label({
                    text: String(day),
                    style_class: 'nats-calendar-day-number',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER
                }));
                if (eventDates.has(`${year}-${month}-${day}`)) {
                    dayCell.add_child(new St.Label({
                        text: '●',
                        style_class: 'nats-calendar-event-dot',
                        x_align: Clutter.ActorAlign.CENTER
                    }));
                }
                row.add_child(dayCell);
            }
            calendarGrid.add_child(row);
        }
        calendar.add_child(calendarGrid);
        page.add_child(calendar);

        const todayEvents = (this._calendarEvents || []).filter((event) => {
            const timestamp = Date.parse(event?.start ?? event?.end ?? '');
            return Number.isFinite(timestamp) &&
                new Date(timestamp).toDateString() === today.toDateString();
        }).slice(0, 2);
        section('TODAY\'S EVENTS');
        if (todayEvents.length > 0) {
            for (const event of todayEvents) {
                const date = new Date(event.start ?? event.end);
                const time = Number.isFinite(date.getTime())
                    ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
                    : '—';
                this._addAssistantPageRow(page, `${time} ${event.title}`);
            }
        } else {
            this._addAssistantPageRow(page, 'No events today');
        }

        return page;
    }

    _buildTasksPage() {
        const page = this._createAssistantPage();
        page.add_child(this._createAssistantSectionTitle('TASKS'));
        if (this._assistantConnection === 'offline' ||
            this._assistantConnection === 'error' ||
            this._assistantConnection === 'unknown' ||
            !this._assistantTasksLoaded) {
            const connectionMessage = this._assistantConnection === 'offline'
                ? 'ASSISTANT OFFLINE'
                : this._assistantConnection === 'error'
                    ? 'ASSISTANT ERROR'
                    : this._assistantConnection === 'unknown'
                        ? 'CONNECTING TO ASSISTANT'
                        : 'LOADING TASKS';
            page.add_child(new St.Label({
                text: connectionMessage,
                style_class: 'nats-ambient-more',
                x_expand: true
            }));
        }
        const tasks = (this._taskState?.tasks ?? this._loadTasks())
            .filter((task) => task && !task.completed);
        const canMutateTasks = this._assistantTasksLoaded &&
            this._assistantConnection === 'online';
        if (tasks.length === 0) {
            page.add_child(new St.Label({
                text: 'No pending tasks',
                style_class: 'nats-ambient-reminder nats-assistant-empty-tasks',
                x_expand: true
            }));
        } else {
            const taskList = new St.BoxLayout({
                vertical: true,
                style_class: 'nats-interaction-content nats-assistant-task-list-content',
                x_expand: true
            });
            this._assistantTaskListScrollView = new St.ScrollView({
                style_class: 'nats-assistant-task-list',
                x_expand: true,
                y_expand: true,
                overlay_scrollbars: true
            });
            this._assistantTaskListScrollView.set_policy(
                St.PolicyType.NEVER,
                St.PolicyType.AUTOMATIC
            );
            this._assistantTaskListScrollView.add_child(taskList);
            page.add_child(this._assistantTaskListScrollView);

            for (const task of tasks) {
                const row = new St.BoxLayout({
                    style_class: 'nats-interaction-stat-row',
                    x_expand: true
                });
                const checkbox = new St.Button({
                    label: task.completed ? '✓' : '○',
                    style_class: 'nats-interaction-button',
                    reactive: canMutateTasks,
                    can_focus: canMutateTasks,
                    x_align: Clutter.ActorAlign.START
                });
                checkbox.connect('clicked', () => {
                    this._updateAssistantTask(task.id, {completed: true});
                });
                row.add_child(checkbox);
                row.add_child(new St.Label({
                    text: task.title,
                    style_class: 'nats-interaction-stat-value',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.START
                }));
                const deleteButton = new St.Button({
                    label: '×',
                    style_class: 'nats-interaction-button nats-interaction-back',
                    reactive: canMutateTasks,
                    can_focus: canMutateTasks
                });
                deleteButton.connect('clicked', () => {
                    this._deleteAssistantTask(task.id);
                });
                row.add_child(deleteButton);
                taskList.add_child(row);
            }
        }

        const actions = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const addTaskButton = new St.Button({
            label: '+ TASK',
            style_class: 'nats-interaction-button nats-interaction-primary',
            x_expand: true,
            can_focus: true
        });
        addTaskButton.connect('clicked', () => this._dispatchAssistantAction('ADD_TASK'));
        const captureButton = new St.Button({
            label: '+ CAPTURE',
            style_class: 'nats-interaction-button',
            x_expand: true,
            can_focus: true
        });
        captureButton.connect('clicked', () => this._dispatchAssistantAction('QUICK_CAPTURE'));
        actions.add_child(addTaskButton);
        actions.add_child(captureButton);
        page.add_child(actions);
        return page;
    }

    _buildAssistantPage() {
        const page = this._createAssistantPage();
        page.add_child(this._createAssistantSectionTitle('ASSISTANT'));
        page.add_child(this._createAssistantSectionTitle('COMMS'));
        const entries = this._getAttentionCommsEntries();
        if (entries.length > 0) {
            for (const entry of entries) {
                const row = new St.BoxLayout({
                    vertical: true,
                    style_class: 'nats-interaction-section',
                    x_expand: true
                });
                const contact = entry.contact || entry.name || 'Conversation';
                const state = entry.state || entry.status || 'ATTENTION';
                row.add_child(new St.Label({
                    text: `${contact} · ${state}`,
                    style_class: 'nats-interaction-stat-value',
                    x_expand: true
                }));
                if (typeof entry.summary === 'string' && entry.summary.trim()) {
                    row.add_child(new St.Label({
                        text: entry.summary.trim(),
                        style_class: 'nats-ambient-reminder',
                        x_expand: true
                    }));
                }
                page.add_child(row);
            }
        } else {
            this._addAssistantPageRow(page, 'Nothing needs attention');
        }
        const commsButton = new St.Button({
            label: 'VIEW COMMS',
            style_class: 'nats-interaction-button',
            x_expand: true,
            can_focus: true
        });
        commsButton.connect('clicked', () => this._setInteractionSection('comms'));
        page.add_child(commsButton);
        page.add_child(this._createAssistantSectionTitle('SYSTEM'));
        const systemGrid = new St.BoxLayout({
            style_class: 'nats-interaction-grid',
            x_expand: true
        });
        const systemColumns = [
            new St.BoxLayout({vertical: true, style_class: 'nats-interaction-column', x_expand: true}),
            new St.BoxLayout({vertical: true, style_class: 'nats-interaction-column', x_expand: true})
        ];
        ['CPU', 'MEMORY', 'NETWORK', 'STORAGE', 'SYSTEM', 'ACTIVITY'].forEach((label, index) => {
            systemColumns[index % 2].add_child(this._createInteractionButton(label));
        });
        systemColumns.forEach((column) => systemGrid.add_child(column));
        page.add_child(systemGrid);
        page.add_child(this._createAssistantSectionTitle('TOOLS'));
        const toolsGrid = new St.BoxLayout({
            style_class: 'nats-interaction-grid',
            x_expand: true
        });
        const toolColumns = [
            new St.BoxLayout({vertical: true, style_class: 'nats-interaction-column', x_expand: true}),
            new St.BoxLayout({vertical: true, style_class: 'nats-interaction-column', x_expand: true})
        ];
        ['BTOP', 'SYSTEM MONITOR', 'FILES', 'TERMINAL'].forEach((label, index) => {
            toolColumns[index % 2].add_child(this._createInteractionButton(label));
        });
        toolColumns.forEach((column) => toolsGrid.add_child(column));
        page.add_child(toolsGrid);
        return page;
    }

    _dispatchAssistantAction(action, payload = null) {
        log(`NATS HUD: assistant action ${action} requested`);
    }

    _buildCommsView() {
        const refs = {};
        this._commsInteractionRefs = refs;
        const entries = this._getAttentionCommsEntries();

        if (entries.length === 0) {
            const row = new St.BoxLayout({
                vertical: true,
                style_class: 'nats-interaction-section',
                x_expand: true
            });
            row.add_child(new St.Label({
                text: 'Nothing needs attention',
                style_class: 'nats-interaction-stat-value',
                x_expand: true
            }));
            this._interactionContent.add_child(row);
            return;
        }

        for (const entry of entries) {
            const card = new St.BoxLayout({
                vertical: true,
                style_class: 'nats-interaction-section',
                x_expand: true
            });
            const contact = entry.contact || entry.name || 'Conversation';
            const state = entry.state || entry.status || 'ATTENTION';
            const priority = String(entry.priority || '').toUpperCase();
            const waiting = typeof entry.waiting_minutes === 'number' && Number.isFinite(entry.waiting_minutes)
                ? `${Math.max(0, entry.waiting_minutes)}m`
                : typeof entry.waiting === 'string' && entry.waiting.trim()
                    ? entry.waiting.trim()
                    : '—';
            const summary = typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : 'No summary available';

            card.add_child(new St.Label({
                text: `${contact} · ${state}`,
                style_class: 'nats-interaction-stat-value',
                x_expand: true
            }));
            card.add_child(new St.Label({
                text: `Priority: ${priority || 'NORMAL'}`,
                style_class: 'nats-ambient-reminder',
                x_expand: true
            }));
            card.add_child(new St.Label({
                text: `Waiting: ${waiting}`,
                style_class: 'nats-ambient-reminder',
                x_expand: true
            }));
            card.add_child(new St.Label({
                text: summary,
                style_class: 'nats-ambient-reminder',
                x_expand: true
            }));
            this._interactionContent.add_child(card);
        }

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const backButton = new St.Button({
            label: 'BACK',
            style_class: 'nats-interaction-button nats-interaction-back',
            x_expand: true,
            can_focus: true
        });
        backButton.connect('clicked', () => this._setInteractionSection('control'));
        footerRow.add_child(backButton);
        this._interactionFooter.add_child(footerRow);
    }

    _buildCpuView() {
        const snapshot = this._lastSnapshot;

        const refs = {};
        this._cpuInteractionRefs = refs;

        const summary = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });

        const loadRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const loadLabel = new St.Label({
            text: 'CPU LOAD',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.usageLabel = new St.Label({
            text: Number.isFinite(snapshot?.cpu?.usagePercent)
                ? formatPercent(snapshot.cpu.usagePercent)
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-cpu',
            x_align: Clutter.ActorAlign.END
        });
        loadRow.add_child(loadLabel);
        loadRow.add_child(refs.usageLabel);
        summary.add_child(loadRow);

        const tempRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const tempLabel = new St.Label({
            text: 'TEMP',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.tempLabel = new St.Label({
            text: Number.isFinite(snapshot?.temperatureCelsius)
                ? formatTemperature(snapshot.temperatureCelsius)
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-cpu',
            x_align: Clutter.ActorAlign.END
        });
        tempRow.add_child(tempLabel);
        tempRow.add_child(refs.tempLabel);
        summary.add_child(tempRow);
        this._interactionContent.add_child(summary);

        const coreSection = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });
        refs.coreRows = [];

        const cores = Array.isArray(snapshot?.cpu?.cores) ? snapshot.cpu.cores : [];
        for (const core of cores.slice(0, 6)) {
            const row = new St.BoxLayout({
                style_class: 'nats-interaction-core-row',
                x_expand: true
            });
            const coreLabel = new St.Label({
                text: core.id ? `C${core.id.replace(/^cpu/, '')}` : 'C0',
                style_class: 'nats-interaction-core-label',
                x_align: Clutter.ActorAlign.START
            });
            const bar = new St.Widget({
                style_class: 'nats-interaction-core-track',
                x_expand: true
            });
            const fill = new St.Widget({
                style_class: 'nats-interaction-core-fill',
                x_align: Clutter.ActorAlign.START
            });
            bar.add_child(fill);
            const usage = Number.isFinite(core.usagePercent) ? core.usagePercent : 0;
            const value = new St.Label({
                text: formatPercent(usage),
                style_class: 'nats-interaction-core-value',
                x_align: Clutter.ActorAlign.END
            });
            const coreRow = {
                value,
                track: bar,
                fill,
                usage,
                coreId: core.id
            };
            bar.connect('notify::width', () => this._updateCpuCoreBarGeometry(coreRow));
            this._updateCpuCoreBarGeometry(coreRow);
            row.add_child(coreLabel);
            row.add_child(bar);
            row.add_child(value);
            refs.coreRows.push(coreRow);
            coreSection.add_child(row);
        }
        this._interactionContent.add_child(coreSection);

        const loadAverage = snapshot?.loadAverage ?? {};
        const loadGroup = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });
        const loadAverageRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const loadAverageLabel = new St.Label({
            text: 'LOAD',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.loadLabel = new St.Label({
            text: [
                formatLoad(loadAverage.oneMinute),
                formatLoad(loadAverage.fiveMinute),
                formatLoad(loadAverage.fifteenMinute)
            ].join('  '),
            style_class: 'nats-interaction-stat-value nats-acc-cpu',
            x_align: Clutter.ActorAlign.END
        });
        loadAverageRow.add_child(loadAverageLabel);
        loadAverageRow.add_child(refs.loadLabel);
        loadGroup.add_child(loadAverageRow);

        const historyLabel = new St.Label({
            text: 'HISTORY',
            style_class: 'nats-interaction-section-label'
        });
        refs.historyLabel = new St.Label({
            text: this._cpuHistory.length > 0 ? makeSparkline(this._cpuHistory, Math.max(100, ...this._cpuHistory)) : '▁▂▃▄▅▆▇█',
            style_class: 'nats-interaction-sparkline'
        });
        loadGroup.add_child(historyLabel);
        loadGroup.add_child(refs.historyLabel);
        this._interactionContent.add_child(loadGroup);

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const openBtopButton = new St.Button({
            label: 'OPEN BTOP',
            style_class: 'nats-interaction-button nats-interaction-primary',
            x_expand: true,
            can_focus: true
        });
        openBtopButton.connect('clicked', () => openBtop());
        footerRow.add_child(openBtopButton);
        this._interactionFooter.add_child(footerRow);
    }

    _renderCpuSection() {
        this._buildCpuView();
    }

    _buildMemoryView() {
        const snapshot = this._lastSnapshot;

        const refs = {};
        this._memoryInteractionRefs = refs;

        const stats = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });

        const percentRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const percentLabel = new St.Label({
            text: 'USED',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.usageLabel = new St.Label({
            text: Number.isFinite(snapshot?.memory?.usagePercent)
                ? formatPercent(snapshot.memory.usagePercent)
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-memory',
            x_align: Clutter.ActorAlign.END
        });
        percentRow.add_child(percentLabel);
        percentRow.add_child(refs.usageLabel);
        stats.add_child(percentRow);

        const usageRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const usageLabel = new St.Label({
            text: 'USED',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.usedLabel = new St.Label({
            text: Number.isFinite(snapshot?.memory?.usedBytes) && Number.isFinite(snapshot?.memory?.totalBytes)
                ? `${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-memory',
            x_align: Clutter.ActorAlign.END
        });
        usageRow.add_child(usageLabel);
        usageRow.add_child(refs.usedLabel);
        stats.add_child(usageRow);

        const availableRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const availableLabel = new St.Label({
            text: 'AVAILABLE',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.availableLabel = new St.Label({
            text: Number.isFinite(snapshot?.memory?.availableBytes)
                ? formatBytes(snapshot.memory.availableBytes)
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-memory',
            x_align: Clutter.ActorAlign.END
        });
        availableRow.add_child(availableLabel);
        availableRow.add_child(refs.availableLabel);
        stats.add_child(availableRow);

        const cacheRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        cacheRow.add_child(new St.Label({
            text: 'CACHE',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.cachedLabel = new St.Label({
            text: formatBytes(snapshot?.memory?.cachedBytes),
            style_class: 'nats-interaction-stat-value nats-acc-memory',
            x_align: Clutter.ActorAlign.END
        });
        cacheRow.add_child(refs.cachedLabel);
        stats.add_child(cacheRow);

        const swapRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        swapRow.add_child(new St.Label({
            text: 'SWAP',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.swapLabel = new St.Label({
            text: Number.isFinite(snapshot?.memory?.swapUsedBytes) &&
                Number.isFinite(snapshot?.memory?.swapTotalBytes)
                ? `${formatBytes(snapshot.memory.swapUsedBytes)} / ${formatBytes(snapshot.memory.swapTotalBytes)}`
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-memory',
            x_align: Clutter.ActorAlign.END
        });
        swapRow.add_child(refs.swapLabel);
        stats.add_child(swapRow);

        this._interactionContent.add_child(stats);

        const barSection = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });
        refs.memoryTrack = new St.Widget({
            style_class: 'nats-memory-bar',
            x_expand: true
        });
        refs.usagePercent = Number.isFinite(snapshot?.memory?.usagePercent)
            ? snapshot.memory.usagePercent
            : null;
        refs.memoryFill = new St.Widget({
            style_class: 'nats-memory-bar-fill',
            x_align: Clutter.ActorAlign.START
        });
        refs.memoryTrack.add_child(refs.memoryFill);
        refs.memoryTrack.connect('notify::width', () => this._updateMemoryBarGeometry(refs));
        this._updateMemoryBarGeometry(refs);
        barSection.add_child(refs.memoryTrack);
        this._interactionContent.add_child(barSection);

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const systemMonitorButton = new St.Button({
            label: 'OPEN SYSTEM MONITOR',
            style_class: 'nats-interaction-button nats-interaction-primary',
            x_expand: true,
            can_focus: true
        });
        systemMonitorButton.connect('clicked', () => openSystemMonitor());
        footerRow.add_child(systemMonitorButton);
        this._interactionFooter.add_child(footerRow);
        this._updateMemoryInteractionView(snapshot);
    }

    _buildNetworkView() {
        const snapshot = this._lastSnapshot;
        const refs = {};
        this._networkInteractionRefs = refs;

        const details = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });

        const interfaceRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const interfaceTitle = new St.Label({
            text: 'INTERFACE',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.interfaceLabel = new St.Label({
            text: snapshot?.network?.interfaceName ?? '--',
            style_class: 'nats-interaction-stat-value nats-acc-network',
            x_align: Clutter.ActorAlign.END
        });
        interfaceRow.add_child(interfaceTitle);
        interfaceRow.add_child(refs.interfaceLabel);
        details.add_child(interfaceRow);

        const downloadRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const downloadTitle = new St.Label({
            text: 'DOWNLOAD',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.downloadLabel = new St.Label({
            text: formatBytesPerSecond(snapshot?.network?.downloadBytesPerSecond),
            style_class: 'nats-interaction-stat-value nats-acc-network',
            x_align: Clutter.ActorAlign.END
        });
        downloadRow.add_child(downloadTitle);
        downloadRow.add_child(refs.downloadLabel);
        details.add_child(downloadRow);

        const uploadRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        const uploadTitle = new St.Label({
            text: 'UPLOAD',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        });
        refs.uploadLabel = new St.Label({
            text: formatBytesPerSecond(snapshot?.network?.uploadBytesPerSecond),
            style_class: 'nats-interaction-stat-value nats-acc-network',
            x_align: Clutter.ActorAlign.END
        });
        uploadRow.add_child(uploadTitle);
        uploadRow.add_child(refs.uploadLabel);
        details.add_child(uploadRow);

        const rxTotalRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        rxTotalRow.add_child(new St.Label({
            text: 'RX TOTAL',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.rxTotalLabel = new St.Label({
            text: formatBytes(snapshot?.network?.rxTotalBytes),
            style_class: 'nats-interaction-stat-value nats-acc-network',
            x_align: Clutter.ActorAlign.END
        });
        rxTotalRow.add_child(refs.rxTotalLabel);
        details.add_child(rxTotalRow);

        const txTotalRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        txTotalRow.add_child(new St.Label({
            text: 'TX TOTAL',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.txTotalLabel = new St.Label({
            text: formatBytes(snapshot?.network?.txTotalBytes),
            style_class: 'nats-interaction-stat-value nats-acc-network',
            x_align: Clutter.ActorAlign.END
        });
        txTotalRow.add_child(refs.txTotalLabel);
        details.add_child(txTotalRow);

        this._interactionContent.add_child(details);

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const systemMonitorButton = new St.Button({
            label: 'OPEN SYSTEM MONITOR',
            style_class: 'nats-interaction-button nats-interaction-primary',
            x_expand: true,
            can_focus: true
        });
        systemMonitorButton.connect('clicked', () => openSystemMonitor());
        footerRow.add_child(systemMonitorButton);
        this._interactionFooter.add_child(footerRow);
        this._updateNetworkInteractionView(snapshot);
    }

    _buildStorageView() {
        const snapshot = this._lastSnapshot;
        const refs = {};
        this._storageInteractionRefs = refs;

        const details = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });

        const rootRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        rootRow.add_child(new St.Label({
            text: 'ROOT',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        rootRow.add_child(new St.Label({
            text: '/',
            style_class: 'nats-interaction-stat-value',
            x_align: Clutter.ActorAlign.END
        }));
        details.add_child(rootRow);

        const usedRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        usedRow.add_child(new St.Label({
            text: 'USED',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.usedLabel = new St.Label({
            text: Number.isFinite(snapshot?.storage?.usedBytes) &&
                Number.isFinite(snapshot?.storage?.totalBytes)
                ? `${formatBytes(snapshot.storage.usedBytes)} / ${formatBytes(snapshot.storage.totalBytes)}`
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-storage',
            x_align: Clutter.ActorAlign.END
        });
        usedRow.add_child(refs.usedLabel);
        details.add_child(usedRow);

        const usageRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        usageRow.add_child(new St.Label({
            text: 'USAGE',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.percentLabel = new St.Label({
            text: formatPercent(snapshot?.storage?.usagePercent),
            style_class: 'nats-interaction-stat-value nats-acc-storage',
            x_align: Clutter.ActorAlign.END
        });
        usageRow.add_child(refs.percentLabel);
        details.add_child(usageRow);

        const availableRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        availableRow.add_child(new St.Label({
            text: 'AVAILABLE',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.availableLabel = new St.Label({
            text: Number.isFinite(snapshot?.storage?.freeBytes)
                ? formatBytes(snapshot.storage.freeBytes)
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-storage',
            x_align: Clutter.ActorAlign.END
        });
        availableRow.add_child(refs.availableLabel);
        details.add_child(availableRow);
        this._interactionContent.add_child(details);

        const barSection = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });
        refs.usagePercent = Number.isFinite(snapshot?.storage?.usagePercent)
            ? snapshot.storage.usagePercent
            : null;
        refs.storageTrack = new St.Widget({
            style_class: 'nats-memory-bar',
            x_expand: true
        });
        refs.storageFill = new St.Widget({
            style_class: 'nats-memory-bar-fill',
            x_align: Clutter.ActorAlign.START
        });
        refs.storageTrack.add_child(refs.storageFill);
        refs.storageTrack.connect(
            'notify::width',
            () => this._updateStorageBarGeometry(refs)
        );
        this._updateStorageBarGeometry(refs);
        barSection.add_child(refs.storageTrack);
        this._interactionContent.add_child(barSection);

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const filesButton = new St.Button({
            label: 'OPEN FILES',
            style_class: 'nats-interaction-button nats-interaction-primary',
            x_expand: true,
            can_focus: true
        });
        filesButton.connect('clicked', () => openFiles());
        footerRow.add_child(filesButton);
        this._interactionFooter.add_child(footerRow);

        this._updateStorageInteractionView(snapshot);
    }

    _buildSystemView() {
        const snapshot = this._lastSnapshot;
        const refs = {};
        this._systemInteractionRefs = refs;

        const details = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });

        const uptimeRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        uptimeRow.add_child(new St.Label({
            text: 'UPTIME',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.uptimeLabel = new St.Label({
            text: formatDuration(snapshot?.uptimeSeconds),
            style_class: 'nats-interaction-stat-value nats-acc-system',
            x_align: Clutter.ActorAlign.END
        });
        uptimeRow.add_child(refs.uptimeLabel);
        details.add_child(uptimeRow);

        const loadRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        loadRow.add_child(new St.Label({
            text: 'LOAD (1 / 5 / 15M)',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.loadLabel = new St.Label({
            text: '',
            style_class: 'nats-interaction-stat-value nats-acc-system',
            x_align: Clutter.ActorAlign.END
        });
        loadRow.add_child(refs.loadLabel);
        details.add_child(loadRow);

        const coresRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        coresRow.add_child(new St.Label({
            text: 'LOGICAL CPUs',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.coresLabel = new St.Label({
            text: '',
            style_class: 'nats-interaction-stat-value nats-acc-system',
            x_align: Clutter.ActorAlign.END
        });
        coresRow.add_child(refs.coresLabel);
        details.add_child(coresRow);

        refs.identity = {};
        for (const [key, label, value] of [
            ['hostname', 'HOST', snapshot?.system?.hostname],
            ['kernel', 'KERNEL', snapshot?.system?.kernelRelease],
            ['osName', 'OS', snapshot?.system?.osName],
            ['architecture', 'ARCH', snapshot?.system?.architecture]
        ]) {
            const row = new St.BoxLayout({
                style_class: 'nats-interaction-stat-row',
                x_expand: true
            });
            row.add_child(new St.Label({
                text: label,
                style_class: 'nats-interaction-stat-label',
                x_expand: true
            }));
            refs.identity[key] = new St.Label({
                text: compactIdentity(value),
                style_class: 'nats-interaction-stat-value nats-acc-system',
                x_align: Clutter.ActorAlign.END
            });
            row.add_child(refs.identity[key]);
            details.add_child(row);
        }
        this._interactionContent.add_child(details);

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const systemMonitorButton = new St.Button({
            label: 'OPEN SYSTEM MONITOR',
            style_class: 'nats-interaction-button nats-interaction-primary',
            x_expand: true,
            can_focus: true
        });
        systemMonitorButton.connect('clicked', () => openSystemMonitor());
        footerRow.add_child(systemMonitorButton);
        this._interactionFooter.add_child(footerRow);

        this._updateSystemInteractionView(snapshot);
    }

    _buildActivityView() {
        const snapshot = this._lastSnapshot;
        const refs = {};
        this._activityInteractionRefs = refs;

        const histories = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-interaction-section',
            x_expand: true
        });

        const cpuHistory = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-history-track',
            x_expand: true
        });
        cpuHistory.add_child(new St.Label({
            text: 'CPU HISTORY',
            style_class: 'nats-history-label'
        }));
        refs.cpuHistory = new SparklineLabel(
            this._cpuHistory,
            Math.max(100, ...this._cpuHistory)
        );
        cpuHistory.add_child(refs.cpuHistory);
        histories.add_child(cpuHistory);

        const networkHistory = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-history-track',
            x_expand: true
        });
        networkHistory.add_child(new St.Label({
            text: 'NETWORK (RX + TX)',
            style_class: 'nats-history-label'
        }));
        refs.networkHistory = new SparklineLabel(
            this._networkHistory,
            Math.max(1024, ...this._networkHistory)
        );
        networkHistory.add_child(refs.networkHistory);
        histories.add_child(networkHistory);

        const memoryHistory = new St.BoxLayout({
            vertical: true,
            style_class: 'nats-history-track',
            x_expand: true
        });
        memoryHistory.add_child(new St.Label({
            text: 'MEMORY HISTORY',
            style_class: 'nats-history-label'
        }));
        refs.memoryHistory = new SparklineLabel(
            this._memoryHistory,
            Math.max(100, ...this._memoryHistory)
        );
        memoryHistory.add_child(refs.memoryHistory);
        histories.add_child(memoryHistory);

        const loadRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        loadRow.add_child(new St.Label({
            text: 'LOAD (1 / 5 / 15M)',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.loadLabel = new St.Label({
            text: '',
            style_class: 'nats-interaction-stat-value nats-acc-activity',
            x_align: Clutter.ActorAlign.END
        });
        loadRow.add_child(refs.loadLabel);
        histories.add_child(loadRow);

        const cpuPeakRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        cpuPeakRow.add_child(new St.Label({
            text: 'CPU PEAK',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.cpuPeakLabel = new St.Label({
            text: this._cpuHistory.length > 0
                ? formatPercent(Math.max(...this._cpuHistory))
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-activity',
            x_align: Clutter.ActorAlign.END
        });
        cpuPeakRow.add_child(refs.cpuPeakLabel);
        histories.add_child(cpuPeakRow);

        const networkPeakRow = new St.BoxLayout({
            style_class: 'nats-interaction-stat-row',
            x_expand: true
        });
        networkPeakRow.add_child(new St.Label({
            text: 'NET PEAK',
            style_class: 'nats-interaction-stat-label',
            x_expand: true
        }));
        refs.networkPeakLabel = new St.Label({
            text: this._networkHistory.length > 0
                ? formatBytesPerSecond(Math.max(...this._networkHistory))
                : '--',
            style_class: 'nats-interaction-stat-value nats-acc-activity',
            x_align: Clutter.ActorAlign.END
        });
        networkPeakRow.add_child(refs.networkPeakLabel);
        histories.add_child(networkPeakRow);
        this._interactionContent.add_child(histories);

        const footerRow = new St.BoxLayout({
            style_class: 'nats-interaction-button-row',
            x_expand: true
        });
        const systemMonitorButton = new St.Button({
            label: 'OPEN SYSTEM MONITOR',
            style_class: 'nats-interaction-button nats-interaction-primary',
            x_expand: true,
            can_focus: true
        });
        systemMonitorButton.connect('clicked', () => openSystemMonitor());
        footerRow.add_child(systemMonitorButton);
        this._interactionFooter.add_child(footerRow);

        this._updateActivityInteractionView(snapshot);
    }

    _createInteractionButton(label) {
        const button = new St.Button({
            label,
            style_class: 'nats-interaction-button',
            x_expand: true,
            can_focus: true
        });

        button.connect('clicked', () => {
            if (label === 'CPU') {
                this._setInteractionSection('cpu');
                log('NATS HUD: requested section CPU');
            } else if (label === 'MEMORY') {
                this._setInteractionSection('memory');
                log('NATS HUD: requested section MEMORY');
            } else if (label === 'NETWORK') {
                this._setInteractionSection('network');
                log('NATS HUD: requested section NETWORK');
            } else if (label === 'STORAGE') {
                this._setInteractionSection('storage');
                log('NATS HUD: requested section STORAGE');
            } else if (label === 'SYSTEM') {
                this._setInteractionSection('system');
                log('NATS HUD: requested section SYSTEM');
            } else if (label === 'ACTIVITY') {
                this._setInteractionSection('activity');
                log('NATS HUD: requested section ACTIVITY');
            } else if (label === 'COMMS') {
                this._setInteractionSection('comms');
                log('NATS HUD: requested section COMMS');
            } else if (label === 'BTOP')
                openBtop();            else if (label === 'SYSTEM MONITOR')
                openSystemMonitor();
            else if (label === 'FILES')
                openFiles();
            else if (label === 'TERMINAL')
                openTerminal();
            else
                log(`NATS HUD: requested section ${label}`);
        });

        return button;
    }

    _positionInteractionPanel() {
        if (!this._interactionPanel)
            return;

        const geometry = this._getInteractionPanelGeometry();
        this._interactionPanel.set_position(geometry.x, geometry.y);
        this._interactionPanel.set_size(geometry.width, geometry.height);
    }

    _showInteractionPanel() {
        if (this._isInteractionOpen())
            return;

        this._activeSection = 'control';
        this._buildInteractionPanel();
        this._positionHud();

        if (this._ambientCard)
            this._ambientCard.hide();

        if (!this._interactionPanel.get_parent())
            Main.uiGroup.add_child(this._interactionPanel);

        this._interactiveMode = true;
        this._interactionPanel.show();
        this._positionInteractionPanel();
        this._setInteractionSection('control');
        this._checkAssistantStatus();
        this._refreshAssistantHome(0);
        this._updateAmbientMode();

        if (this._escapeSignalId)
            global.stage.disconnect(this._escapeSignalId);
        this._escapeSignalId = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS ||
                event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;

            this._hideInteractionPanel();
            return Clutter.EVENT_STOP;
        });
        log('NATS HUD: entered interactive mode');
    }

    _hideInteractionPanel() {
        if (this._escapeSignalId) {
            global.stage.disconnect(this._escapeSignalId);
            this._escapeSignalId = null;
        }

        const panel = this._interactionPanel;
        if (panel) {
            this._clearInteractionContent();
            const parent = panel.get_parent();
            if (parent)
                parent.remove_child(panel);
            panel.destroy();
        }

        this._interactionPanel = null;
        this._interactionHeader = null;
        this._interactionToolbar = null;
        this._interactionBackButton = null;
        this._interactionScrollView = null;
        this._interactionContent = null;
        this._interactionFooter = null;
        this._activeSection = 'control';
        this._interactiveMode = false;
        this._assistantClient?.cancelAll();
        if (this._ambientCard)
            this._ambientCard.show();
        this._updateAmbientMode();
        this._positionHud();
        log('NATS HUD: exited interactive mode');
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
            this._lastSnapshot = currentSnapshot;
            this._updateAmbientCard();
            const cpuUsage = currentSnapshot.cpu.usagePercent;
            const memory = currentSnapshot.memory;
            const network = currentSnapshot.network;
            const storage = currentSnapshot.storage;

            this._cpuValue.update(formatPercent(cpuUsage));
            this._cpuProgress.update(cpuUsage, formatPercent(cpuUsage));
            const cpuLoad = currentSnapshot.loadAverage;
            if (this._cpuDetailRows.temperature)
                this._cpuDetailRows.temperature.value.text =
                    formatTemperature(currentSnapshot.temperatureCelsius);
            if (this._cpuDetailRows.frequency)
                this._cpuDetailRows.frequency.value.text =
                    formatFrequency(currentSnapshot.cpu.frequencyMHz);

            if (Number.isFinite(cpuUsage)) {
                this._cpuHistory.push(cpuUsage);
                if (this._cpuHistory.length > CPU_HISTORY_LIMIT)
                    this._cpuHistory.shift();
            }
            if (Number.isFinite(memory.usagePercent)) {
                this._memoryHistory.push(memory.usagePercent);
                if (this._memoryHistory.length > CPU_HISTORY_LIMIT)
                    this._memoryHistory.shift();
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
            if (this._networkDetailRows.rxTotal)
                this._networkDetailRows.rxTotal.value.text = formatBytes(network.rxTotalBytes);
            if (this._networkDetailRows.txTotal)
                this._networkDetailRows.txTotal.value.text = formatBytes(network.txTotalBytes);
            if (this._interactiveMode && this._interactionPanel &&
                this._activeSection === 'network') {
                this._updateNetworkInteractionView(currentSnapshot);
            }

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
            this._activityMemorySparkline.update(
                this._memoryHistory,
                Math.max(100, ...this._memoryHistory)
            );
            this._activityPeakRows.cpu.value.text =
                this._cpuHistory.length > 0
                    ? formatPercent(Math.max(...this._cpuHistory))
                    : '--';
            this._activityPeakRows.network.value.text =
                this._networkHistory.length > 0
                    ? formatBytesPerSecond(Math.max(...this._networkHistory))
                    : '--';

            this._storageValue.update(formatPercent(storage.usagePercent));
            this._storageProgress.update(
                storage.usagePercent,
                `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.totalBytes)}`
            );
            this._storageFree.text = `FREE ${formatBytes(storage.freeBytes)}`;
            if (this._storageDetailRows.mountPoint)
                this._storageDetailRows.mountPoint.value.text = storage.mountPoint ?? '/';
            if (this._storageDetailRows.filesystemType)
                this._storageDetailRows.filesystemType.value.text =
                    storage.filesystemType ?? '--';

            this._memoryValue.update(formatPercent(memory.usagePercent));
            if (this._memoryDetailRows.available)
                this._memoryDetailRows.available.value.text = formatBytes(memory.availableBytes);
            if (this._memoryDetailRows.cached)
                this._memoryDetailRows.cached.value.text = formatBytes(memory.cachedBytes);
            if (this._memoryDetailRows.swap)
                this._memoryDetailRows.swap.value.text =
                    Number.isFinite(memory.swapUsedBytes) &&
                    Number.isFinite(memory.swapTotalBytes)
                        ? `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}`
                        : '--';
            this._memoryProgress.update(
                memory.usagePercent,
                `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`
            );

            const loadAverage = currentSnapshot.loadAverage;
            this._systemMetrics.uptime.update(formatDuration(currentSnapshot.uptimeSeconds));
            this._systemMetrics.loadOne.update(formatLoad(loadAverage.oneMinute));
            this._systemMetrics.loadFive.update(formatLoad(loadAverage.fiveMinute));
            this._systemMetrics.loadFifteen.update(formatLoad(loadAverage.fifteenMinute));
            const system = currentSnapshot.system ?? {};
            if (this._systemIdentityRows.hostname)
                this._systemIdentityRows.hostname.value.text = compactIdentity(system.hostname);
            if (this._systemIdentityRows.kernel)
                this._systemIdentityRows.kernel.value.text = compactIdentity(system.kernelRelease);
            if (this._systemIdentityRows.osName)
                this._systemIdentityRows.osName.value.text = compactIdentity(system.osName);
            if (this._systemIdentityRows.architecture)
                this._systemIdentityRows.architecture.value.text = compactIdentity(system.architecture);
            if (this._systemIdentityRows.logicalCpus)
                this._systemIdentityRows.logicalCpus.value.text =
                    Number.isFinite(currentSnapshot.cpu.logicalCpuCount)
                        ? String(currentSnapshot.cpu.logicalCpuCount)
                        : '--';

            if (this._interactiveMode && this._interactionPanel &&
                this._activeSection !== 'network') {
                this._updateActiveInteractionView(currentSnapshot);
            }
        } catch (error) {
            logError(error, 'NATS HUD: Failed to update system telemetry');
        }
    }

    disable() {
        Main.wm.removeKeybinding('toggle-interactive-mode');
        this._assistantClient?.dispose();
        this._assistantClient = null;
        this._assistantConnection = 'unknown';
        this._assistantVersion = null;
        this._assistantHome = null;
        this._assistantTasksLoaded = false;

        if (this._escapeSignalId) {
            global.stage.disconnect(this._escapeSignalId);
            this._escapeSignalId = null;
        }
        if (this._interactionPanel) {
            const parent = this._interactionPanel.get_parent();
            if (parent)
                parent.remove_child(this._interactionPanel);
            this._clearInteractionContent();
            this._interactionPanel.destroy();
            this._interactionPanel = null;
        }
        this._interactionHeader = null;
        this._interactionToolbar = null;
        this._interactionBackButton = null;
        this._interactionScrollView = null;
        this._interactionContent = null;
        this._interactionFooter = null;
        this._assistantHomeShell = null;
        this._assistantPageHost = null;
        this._assistantPagerNav = null;
        this._assistantPrevButton = null;
        this._assistantNextButton = null;
        this._assistantDot0Button = null;
        this._assistantDot1Button = null;
        this._assistantDot2Button = null;
        this._assistantPageActor = null;
        this._assistantPageIndicators = null;
        this._assistantTaskListScrollView = null;
        this._cpuInteractionRefs = null;
        this._memoryInteractionRefs = null;
        this._networkInteractionRefs = null;
        this._storageInteractionRefs = null;
        this._systemInteractionRefs = null;
        this._activityInteractionRefs = null;
        this._interactiveMode = false;

        if (this._timer !== null && this._timer !== undefined) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }

        if (this._monitorChangedId) {
            Main.layoutManager.disconnect(this._monitorChangedId);
            this._monitorChangedId = null;
        }

        if (this._assistantMonitor) {
            this._assistantMonitor.cancel();
            this._assistantMonitor = null;
        }

        if (this._startupLayoutId !== 0) {
            GLib.source_remove(this._startupLayoutId);
            this._startupLayoutId = 0;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._ambientCard?.destroy();
        this._systemCard?.destroy();
        this._ambientCard = null;
        this._systemCard = null;

        if (this._hud) {
            this._hud.destroy();
            this._hud = null;
        }
        this._telemetry = null;
        this._cpuHistory = [];
        this._memoryHistory = [];
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
        this._cpuDetails = null;
        this._cpuDetailRows = null;
        this._memoryDetails = null;
        this._memoryDetailRows = null;
        this._networkDetails = null;
        this._networkDetailRows = null;
        this._storageCard = null;
        this._storageValue = null;
        this._storageProgress = null;
        this._storageFree = null;
        this._storageDetails = null;
        this._storageDetailRows = null;
        this._coreMetrics = null;
        this._coreColumns = null;
        this._coreGrid = null;
        this._systemMetrics = null;
        this._systemIdentity = null;
        this._systemIdentityRows = null;
        this._activityCpuSparkline = null;
        this._activityMemorySparkline = null;
        this._activityNetworkSparkline = null;
        this._activityPeakRows = null;
        this._activityCard = null;
        this._ambientDateHeader = null;
        this._ambientDateTitle = null;
        this._ambientDateValue = null;
        this._assistantNowHeading = null;
        this._assistantNowValue = null;
        this._assistantNextHeading = null;
        this._assistantNextValue = null;
        this._assistantNextMeta = null;
        this._ambientReminderHeading = null;
        this._ambientReminderList = null;
        this._ambientReminderLabels = null;
        this._ambientMoreLabel = null;
        this._assistantCalendarHeading = null;
        this._ambientCalendarHeading = null;
        this._ambientCalendarTitle = null;
        this._ambientCalendar = null;
        this._assistantTaskHeading = null;
        this._assistantTaskList = null;
        this._assistantTaskMore = null;
        this._assistantCommsHeading = null;
        this._assistantCommsValue = null;
        this._ambientWeekdays = null;
        this._ambientCalendarGrid = null;
        this._ambientCalendarDateKey = null;
        this._ambientShortcut = null;
        this._settings = null;
    }
}
