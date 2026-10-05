import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ASSISTANT_DIR = `${GLib.get_home_dir()}/.local/share/nats-assistant`;

function ensureDirectory(path) {
    try {
        const dir = Gio.File.new_for_path(path);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
    } catch (_error) {
        // Ignore directory-creation errors to keep GNOME Shell responsive.
    }
}

function readJsonFile(path, fallback) {
    if (!path)
        return fallback;

    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return fallback;

        const [, contents] = file.load_contents(null);
        if (!contents || contents.length === 0)
            return fallback;

        const decoded = new TextDecoder('utf-8').decode(contents);
        const parsed = JSON.parse(decoded);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_error) {
        return fallback;
    }
}

function writeJsonFile(path, value) {
    try {
        ensureDirectory(ASSISTANT_DIR);
        const file = Gio.File.new_for_path(path);
        const parent = file.get_parent();
        if (parent && !parent.query_exists(null))
            parent.make_directory_with_parents(null);

        const data = new TextEncoder().encode(JSON.stringify(value, null, 2));
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        stream.write_all(data, null);
        stream.close(null);
        return true;
    } catch (_error) {
        return false;
    }
}

function normalizeTask(task) {
    if (!task || typeof task !== 'object')
        return null;

    const title = typeof task.title === 'string' ? task.title.trim() : '';
    if (!title)
        return null;

    return {
        id: typeof task.id === 'string' && task.id.trim() ? task.id.trim() : `task-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        title,
        due: typeof task.due === 'string' ? task.due : null,
        completed: Boolean(task.completed),
        priority: typeof task.priority === 'string' && task.priority.trim() ? task.priority.toLowerCase() : 'normal',
        source: typeof task.source === 'string' && task.source.trim() ? task.source : 'manual'
    };
}

export function readCalendarState() {
    const fallback = {updated_at: null, events: []};
    const state = readJsonFile(`${ASSISTANT_DIR}/calendar.json`, fallback);
    const events = Array.isArray(state.events) ? state.events : [];

    return {
        updated_at: typeof state.updated_at === 'string' ? state.updated_at : null,
        events: events
            .filter((event) => event && typeof event === 'object')
            .map((event) => ({
                ...event,
                id: typeof event.id === 'string' ? event.id : `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                title: typeof event.title === 'string' ? event.title.trim() : '',
                start: typeof event.start === 'string' ? event.start : null,
                end: typeof event.end === 'string' ? event.end : null,
                all_day: Boolean(event.all_day),
                source: typeof event.source === 'string' ? event.source : 'manual'
            }))
            .filter((event) => event.title && (event.start || event.end))
    };
}

export function readTaskState() {
    const fallback = {updated_at: null, tasks: []};
    const state = readJsonFile(`${ASSISTANT_DIR}/tasks.json`, fallback);
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];

    return {
        updated_at: typeof state.updated_at === 'string' ? state.updated_at : null,
        tasks: tasks
            .map((task) => normalizeTask(task))
            .filter(Boolean)
    };
}

export function writeTaskState(nextState) {
    const payload = {
        updated_at: new Date().toISOString(),
        tasks: Array.isArray(nextState?.tasks)
            ? nextState.tasks
                .map((task) => normalizeTask(task))
                .filter(Boolean)
            : []
    };

    return writeJsonFile(`${ASSISTANT_DIR}/tasks.json`, payload);
}

export function addTask(task) {
    const state = readTaskState();
    const normalized = normalizeTask(task);
    if (!normalized)
        return null;

    const nextTasks = [...state.tasks, normalized];
    const success = writeTaskState({tasks: nextTasks});
    return success ? normalized : null;
}

export function toggleTask(taskId) {
    const state = readTaskState();
    let changed = false;
    const nextTasks = state.tasks.map((task) => {
        if (task.id !== taskId)
            return task;

        changed = true;
        return {...task, completed: !Boolean(task.completed)};
    });

    if (!changed)
        return null;

    const success = writeTaskState({tasks: nextTasks});
    return success ? nextTasks.find((task) => task.id === taskId) ?? null : null;
}

export function deleteTask(taskId) {
    const state = readTaskState();
    const nextTasks = state.tasks.filter((task) => task.id !== taskId);
    if (nextTasks.length === state.tasks.length)
        return false;

    return writeTaskState({tasks: nextTasks});
}

export function readCommsState() {
    const fallback = {updated_at: null, entries: []};
    const state = readJsonFile(`${ASSISTANT_DIR}/comms.json`, fallback);
    const entries = Array.isArray(state.entries) ? state.entries : [];

    return {
        updated_at: typeof state.updated_at === 'string' ? state.updated_at : null,
        entries: entries.filter((entry) => entry && typeof entry === 'object')
    };
}

export function readFocusState() {
    const fallback = {updated_at: null, focus: null};
    const state = readJsonFile(`${ASSISTANT_DIR}/focus.json`, fallback);

    return {
        updated_at: typeof state.updated_at === 'string' ? state.updated_at : null,
        focus: state.focus && typeof state.focus === 'object' ? state.focus : null
    };
}
