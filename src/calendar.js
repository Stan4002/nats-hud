import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

export function calendarDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function eventsOnCalendarDate(events, key) {
    const day = new Date(`${key}T00:00:00`);
    const start = day.getTime();
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    if (!Number.isFinite(start))
        return [];
    const seen = new Set();
    return (Array.isArray(events) ? events : []).filter((event) => {
        const from = Date.parse(event?.start ?? '');
        const to = Date.parse(event?.end ?? '');
        const identity = `${event?.id ?? event?.title}:${event?.start}`;
        if (event?.status === 'cancelled' || !Number.isFinite(from) ||
            from >= end || (Number.isFinite(to) ? to : from + 1) <= start || seen.has(identity))
            return false;
        seen.add(identity);
        return true;
    }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function createCalendar({compact = false} = {}) {
    const calendar = new St.BoxLayout({
        vertical: true,
        style_class: compact ? 'nats-calendar nats-calendar-compact' : 'nats-calendar',
        x_expand: true
    });
    const header = new St.BoxLayout({style_class: 'nats-calendar-header', x_expand: true});
    calendar.monthLabel = new St.Label({
        text: '', style_class: 'nats-calendar-month', x_expand: true,
        x_align: Clutter.ActorAlign.CENTER
    });
    header.add_child(calendar.monthLabel);
    calendar.add_child(header);
    calendar.weekdayRow = new St.BoxLayout({style_class: 'nats-calendar-weekdays', x_expand: true});
    for (const day of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
        calendar.weekdayRow.add_child(new St.Label({
            text: day, style_class: 'nats-calendar-weekday', x_expand: true,
            x_align: Clutter.ActorAlign.CENTER
        }));
    }
    calendar.add_child(calendar.weekdayRow);
    calendar.grid = new St.BoxLayout({vertical: true, style_class: 'nats-calendar-grid', x_expand: true});
    calendar.add_child(calendar.grid);
    calendar.dayButtons = new Map();
    return calendar;
}

export function updateCalendar(calendar, {today, events = [], selectedDate = null, onSelect = null}) {
    const year = today.getFullYear();
    const month = today.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    const marked = new Set();
    for (let day = 1; day <= days; day++) {
        const key = calendarDateKey(new Date(year, month, day));
        if (eventsOnCalendarDate(events, key).length > 0)
            marked.add(key);
    }
    const todayKey = calendarDateKey(today);
    const renderKey = `${todayKey}|${selectedDate}|${Boolean(onSelect)}|${[...marked].join(',')}`;
    if (calendar.renderKey === renderKey)
        return;
    calendar.renderKey = renderKey;
    calendar.monthLabel.text = GLib.DateTime.new_local(year, month + 1, 1, 0, 0, 0).format('%B %Y').toUpperCase();
    for (const child of calendar.grid.get_children()) {
        calendar.grid.remove_child(child);
        child.destroy();
    }
    calendar.dayButtons.clear();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    const count = Math.ceil((offset + days) / 7) * 7;
    for (let cell = 0; cell < count; cell += 7) {
        const row = new St.BoxLayout({style_class: 'nats-calendar-row', x_expand: true});
        for (let column = 0; column < 7; column++) {
            const day = cell + column - offset + 1;
            if (day < 1 || day > days) {
                row.add_child(new St.Widget({style_class: 'nats-calendar-day', x_expand: true}));
                continue;
            }
            const key = calendarDateKey(new Date(year, month, day));
            const classes = `nats-calendar-day${key === todayKey ? ' nats-calendar-today' : ''}${key === selectedDate ? ' nats-calendar-selected' : ''}`;
            const content = new St.BoxLayout({vertical: true, x_expand: true});
            content.add_child(new St.Label({text: String(day), style_class: 'nats-calendar-day-number', x_align: Clutter.ActorAlign.CENTER}));
            if (marked.has(key))
                content.add_child(new St.Label({text: '●', style_class: 'nats-calendar-event-dot', x_align: Clutter.ActorAlign.CENTER}));
            if (onSelect) {
                const button = new St.Button({style_class: classes, reactive: true, can_focus: true, x_expand: true});
                button.set_child(content);
                button._natsCalendarDate = key;
                button.connect('clicked', () => onSelect(key));
                button.connect('key-press-event', (_actor, event) => {
                    const symbol = event.get_key_symbol();
                    if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(symbol))
                        return Clutter.EVENT_PROPAGATE;
                    onSelect(key);
                    return Clutter.EVENT_STOP;
                });
                calendar.dayButtons.set(key, button);
                row.add_child(button);
            } else {
                content.style_class = classes;
                row.add_child(content);
            }
        }
        calendar.grid.add_child(row);
    }
}
