import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const BASE_URL = 'http://127.0.0.1:8765/v1';
const REQUEST_TIMEOUT_SECONDS = 3;

export class AssistantClientError extends Error {
    constructor(message, kind = 'request') {
        super(message);
        this.name = 'AssistantClientError';
        this.kind = kind;
    }
}

function normalizeTask(task) {
    if (!task || typeof task !== 'object' ||
        typeof task.id !== 'string' || !task.id ||
        typeof task.title !== 'string' || typeof task.completed !== 'boolean')
        throw new AssistantClientError('Assistant returned an invalid task', 'response');
    const title = task.title.trim();
    if (!title)
        throw new AssistantClientError('Assistant returned an invalid task', 'response');

    return {
        id: task.id,
        title,
        description: typeof task.description === 'string' ? task.description : null,
        completed: task.completed,
        priority: ['low', 'normal', 'high', 'critical'].includes(task.priority)
            ? task.priority
            : 'normal',
        due: typeof task.due === 'string' ? task.due : null,
        source: typeof task.source === 'string' ? task.source : 'nats',
        created_at: typeof task.created_at === 'string' ? task.created_at : null,
        updated_at: typeof task.updated_at === 'string' ? task.updated_at : null
    };
}

function normalizeCapture(capture) {
    if (!capture || typeof capture !== 'object' ||
        typeof capture.id !== 'string' || !capture.id ||
        typeof capture.text !== 'string')
        throw new AssistantClientError('Assistant returned an invalid capture', 'response');

    const text = capture.text.trim();
    if (!text)
        throw new AssistantClientError('Assistant returned an invalid capture', 'response');

    const status = typeof capture.status === 'string' ? capture.status : 'inbox';
    return {
        id: capture.id,
        text,
        status: ['inbox', 'processed', 'archived'].includes(status) ? status : 'inbox',
        source: typeof capture.source === 'string' ? capture.source : 'nats',
        created_at: typeof capture.created_at === 'string' ? capture.created_at : null,
        updated_at: typeof capture.updated_at === 'string' ? capture.updated_at : null
    };
}

function normalizeCalendarEvent(event) {
    if (!event || typeof event !== 'object' || event.status === 'cancelled' ||
        typeof event.id !== 'string' || !event.id ||
        typeof event.title !== 'string' || !event.title.trim())
        return null;

    const awareTimestamp = (value) => typeof value === 'string' &&
        /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
    if (!awareTimestamp(event.start) || !awareTimestamp(event.end) ||
        Date.parse(event.end) <= Date.parse(event.start))
        return null;

    return {
        id: event.id,
        title: event.title.trim(),
        description: typeof event.description === 'string' ? event.description : null,
        start: event.start,
        end: event.end,
        all_day: event.all_day === true,
        location: typeof event.location === 'string' ? event.location.trim() : null,
        source: typeof event.source === 'string' ? event.source : null,
        source_calendar_id: typeof event.source_calendar_id === 'string' ? event.source_calendar_id : null,
        source_event_id: typeof event.source_event_id === 'string' ? event.source_event_id : null,
        status: typeof event.status === 'string' ? event.status : null,
        url: typeof event.url === 'string' ? event.url : null
    };
}

function normalizeCalendar(calendar) {
    // Older backends omit this field; only that case permits local fallback.
    if (calendar === undefined || calendar === null)
        return null;
    const empty = {status: 'error', today_count: 0, next: null, events: [], truncated: false};
    if (typeof calendar !== 'object' ||
        !['online', 'offline', 'error', 'not_connected'].includes(calendar.status) ||
        !Array.isArray(calendar.events))
        return empty;
    if (calendar.status !== 'online')
        return {...empty, status: calendar.status};

    const events = calendar.events.map(normalizeCalendarEvent).filter(Boolean)
        .sort((first, second) => Date.parse(first.start) - Date.parse(second.start));
    return {
        status: calendar.status,
        today_count: Number.isInteger(calendar.today_count) && calendar.today_count >= 0
            ? calendar.today_count : events.length,
        next: normalizeCalendarEvent(calendar.next),
        events,
        truncated: calendar.truncated === true
    };
}

export class AssistantClient {
    constructor() {
        this._session = new Soup.Session({
            timeout: REQUEST_TIMEOUT_SECONDS,
            idle_timeout: REQUEST_TIMEOUT_SECONDS
        });
        this._cancellables = new Set();
        this._requestTimeouts = new Map();
        this._disposed = false;
        this._taskRequestId = 0;
        this._homeRequestId = 0;
        this._lastHome = null;
        this._lastTasks = null;
    }

    get lastHome() {
        return this._lastHome;
    }

    get lastTasks() {
        return this._lastTasks;
    }

    checkStatus() {
        return this._request('GET', '/status').then((status) => {
            if (!status || status.service !== 'nats-assistant' ||
                status.status !== 'online' || typeof status.version !== 'string')
                throw new AssistantClientError('Assistant returned an invalid status', 'response');
            return status;
        });
    }

    getHome() {
        const requestId = ++this._homeRequestId;
        return this._request('GET', '/home').then((home) => {
            if (!home || typeof home !== 'object' ||
                !home.tasks || typeof home.tasks !== 'object' ||
                !Array.isArray(home.tasks.items))
                throw new AssistantClientError('Assistant returned an invalid home summary', 'response');
            const normalized = {
                now: home.now ?? null,
                next: home.next ?? null,
                upcoming: Array.isArray(home.upcoming) ? home.upcoming : [],
                tasks: {
                    pending: Number.isInteger(home.tasks.pending) ? home.tasks.pending : 0,
                    due_today: Number.isInteger(home.tasks.due_today) ? home.tasks.due_today : 0,
                    items: home.tasks.items.map(normalizeTask)
                },
                calendar: normalizeCalendar(home.calendar),
                captures: home.captures && typeof home.captures === 'object'
                    ? {
                        inbox_count: Number.isInteger(home.captures.inbox_count) ? home.captures.inbox_count : 0
                    }
                    : {inbox_count: 0},
                comms: home.comms && typeof home.comms === 'object'
                    ? home.comms
                    : {attention_count: 0, items: []}
            };
            if (requestId !== this._homeRequestId)
                throw new AssistantClientError('Home request was superseded', 'cancelled');
            this._lastHome = normalized;
            return normalized;
        });
    }

    getTasks() {
        const requestId = ++this._taskRequestId;
        return this._request('GET', '/tasks').then((tasks) => {
            if (!Array.isArray(tasks))
                throw new AssistantClientError('Assistant returned an invalid task list', 'response');
            const normalized = tasks.map(normalizeTask);
            if (requestId !== this._taskRequestId)
                throw new AssistantClientError('Task request was superseded', 'cancelled');
            this._lastTasks = normalized;
            return normalized;
        });
    }

    createTask(task) {
        return this._request('POST', '/tasks', task).then(normalizeTask);
    }

    updateTask(taskId, patch) {
        return this._request(
            'PATCH',
            `/tasks/${encodeURIComponent(taskId)}`,
            patch
        ).then(normalizeTask);
    }

    deleteTask(taskId) {
        return this._request(
            'DELETE',
            `/tasks/${encodeURIComponent(taskId)}`,
            undefined,
            false
        );
    }

    createCapture(capture) {
        return this._request('POST', '/captures', capture).then(normalizeCapture);
    }

    cancelAll() {
        for (const [cancellable, timeoutId] of this._requestTimeouts) {
            if (timeoutId)
                GLib.source_remove(timeoutId);
            this._requestTimeouts.set(cancellable, 0);
            cancellable.cancel();
        }
    }

    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        this.cancelAll();
        this._session.abort();
        this._cancellables.clear();
        this._requestTimeouts.clear();
        this._lastHome = null;
        this._lastTasks = null;
    }

    _request(method, path, payload = undefined, expectsJson = true) {
        if (this._disposed)
            return Promise.reject(new AssistantClientError('Assistant client is unavailable', 'cancelled'));

        const message = Soup.Message.new(method, `${BASE_URL}${path}`);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        if (payload !== undefined) {
            const body = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload)));
            message.set_request_body_from_bytes('application/json', body);
        }

        const cancellable = new Gio.Cancellable();
        this._cancellables.add(cancellable);

        return new Promise((resolve, reject) => {
            let timedOut = false;
            let timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                REQUEST_TIMEOUT_SECONDS,
                () => {
                    timedOut = true;
                    timeoutId = 0;
                    this._requestTimeouts.set(cancellable, 0);
                    cancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                }
            );
            this._requestTimeouts.set(cancellable, timeoutId);

            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (session, result) => {
                    const requestTimeoutId = this._requestTimeouts.get(cancellable);
                    if (requestTimeoutId)
                        GLib.source_remove(requestTimeoutId);
                    this._requestTimeouts.delete(cancellable);
                    this._cancellables.delete(cancellable);
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const statusCode = message.get_status();
                        if (statusCode < 200 || statusCode >= 300)
                            throw new AssistantClientError(
                                `Assistant returned HTTP ${statusCode}`,
                                'http'
                            );
                        if (!expectsJson)
                            return resolve(null);

                        const text = new TextDecoder('utf-8').decode(bytes.get_data());
                        try {
                            resolve(JSON.parse(text));
                        } catch (_error) {
                            reject(new AssistantClientError('Assistant returned invalid JSON', 'response'));
                        }
                    } catch (error) {
                        if (timedOut) {
                            reject(new AssistantClientError('Assistant request timed out', 'timeout'));
                        } else if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                            reject(new AssistantClientError('Assistant request was cancelled', 'cancelled'));
                        } else if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) {
                            reject(new AssistantClientError('Assistant request timed out', 'timeout'));
                        } else if (error instanceof AssistantClientError) {
                            reject(error);
                        } else {
                            reject(new AssistantClientError('Could not connect to assistant', 'offline'));
                        }
                    }
                }
            );
        });
    }
}
