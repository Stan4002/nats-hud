// Run: node tests/passive-overview.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

process.env.TZ = 'Africa/Lusaka';
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const inspiration = await import(`data:text/javascript;base64,${Buffer.from(read('src/inspiration.js')).toString('base64')}`);
const {compactText, greetingForHour, loadVerses, selectDailyVerse} = inspiration;
const verses = loadVerses({load_contents: () => [true, new TextEncoder().encode(read('assets/verses-kjv.json'))]});
let checks = 0;
function check(condition, message) {
    assert.ok(condition, message);
    checks++;
}

let clock = new Date('2026-10-06T03:10:00+02:00');
const originalNow = Date.now;
Date.now = () => clock.getTime();
function localDate(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return {
        get_hour: () => date.getHours(),
        get_year: () => date.getFullYear(),
        get_month: () => date.getMonth() + 1,
        get_day: () => date.getDate(),
        format: (format) => {
            const year = date.getFullYear();
            const month = pad(date.getMonth() + 1);
            const day = pad(date.getDate());
            const formats = {
                '%Y-%m-%d': `${year}-${month}-${day}`,
                '%H:%M': `${pad(date.getHours())}:${pad(date.getMinutes())}`,
                '%A': date.toLocaleDateString('en-GB', {weekday: 'long'}),
                '%d %B': `${day} ${date.toLocaleDateString('en-GB', {month: 'long'})}`,
                '%d %b': `${day} ${date.toLocaleDateString('en-GB', {month: 'short'})}`,
                '%B %Y': `${date.toLocaleDateString('en-GB', {month: 'long'})} ${year}`
            };
            assert.ok(format in formats, `Unknown date format: ${format}`);
            return formats[format];
        }
    };
}
const GLib = {DateTime: {
    new_now_local: () => localDate(clock),
    new_local: (year, month, day) => localDate(new Date(year, month - 1, day)),
    new_from_unix_local: (seconds) => localDate(new Date(seconds * 1000))
}};
const sources = new Map();
let sourceSerial = 0;
Object.assign(GLib, {
    PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
    timeout_add_seconds: (_priority, seconds, callback) => {
        const id = ++sourceSerial;sources.set(id, {seconds, callback});return id;
    },
    source_remove: (id) => sources.delete(id)
});
let stageFocus = null;
class Actor {
    constructor(properties = {}) {
        Object.assign(this, {visible: true, text: '', children: []}, properties);
        this.clutter_text = {
            set_single_line_mode: (value) => { this.singleLine = value; },
            set_line_wrap: (value) => { this.wrap = value; },
            set_ellipsize: (value) => { this.ellipsis = value; }
        };
    }
    add_child(child) { this.children.push(child);child.parent = this; }
    get_children() { return [...this.children]; }
    get_parent() { return this.parent ?? null; }
    remove_child(child) { this.children = this.children.filter(c => c !== child);child.parent = null; }
    destroy() { this.destroyed = true;for (const child of this.children) child.destroy();this.children = []; }
    contains(actor) { return actor === this || this.children.some(child => child.contains(actor)); }
    set_child(child) { this.add_child(child);child.parent = this; }
    connect(signal, callback) { (this.signals ??= new Map()).set(signal, callback);return 1; }
    emit(signal, ...args) { return this.signals.get(signal)(this, ...args); }
    grab_key_focus() { stageFocus = this; }
    remove_all_children() { this.children = []; }
    hide() { this.visible = false; }
    // Construction has no allocation. Data must still be presented.
    has_allocation() { throw Error('Data logic queried allocation'); }
    get_height() { throw Error('Data logic queried actor height'); }
    get_width() { throw Error('Data logic queried actor width'); }
    get_preferred_height() { throw Error('Data logic queried preferred height'); }
}
const St = {Label: Actor, BoxLayout: Actor, Widget: Actor, Button: class extends Actor {}, Entry: class extends Actor {}};
const Clutter = {ActorAlign: {CENTER: 0}, EventType: {KEY_PRESS: 1}, EVENT_STOP: true, EVENT_PROPAGATE: false,
    KEY_Left: 10, KEY_Right: 11, KEY_Escape: 12, KEY_Return: 13, KEY_KP_Enter: 14, KEY_space: 15,
    Text: class extends Actor {get_editable() { return this.editable; }}};
const Pango = {EllipsizeMode: {END: 1}};
const HudDate = class extends Date {constructor(...args) {super(...(args.length ? args : [clock.getTime()]));}};
const calendarSource = read('src/calendar.js').replace(/^import .*;\n/gm, '').replace(/export function/g, 'function');
const {calendarDateKey, createCalendar, updateCalendar, eventsOnCalendarDate} = Function('St', 'Clutter', 'GLib', 'Date',
    `${calendarSource}\nreturn {calendarDateKey,createCalendar,updateCalendar,eventsOnCalendarDate};`)(St, Clutter, GLib, HudDate);
const globalShim = {stage: {get_key_focus: () => stageFocus, disconnect() {}}};
const Main = {wm: {removeKeybinding() {}}, layoutManager: {disconnect() {}}};
const extension = read('extension.js');
function method(name) {
    const match = new RegExp(`^    (?:async )?${name}\\([^\\n]*\\) \\{`, 'm').exec(extension);
    assert.ok(match, name);
    const start = match.index;
    const rest = extension.slice(start + match[0].length);
    const next = /^    (?:async )?\w+\([^\n]*\) \{/m.exec(rest);
    return extension.slice(start, next ? start + match[0].length + next.index : extension.lastIndexOf('\n}'));
}
const methods = ['_buildAmbientCard', '_renderAmbientEvents', '_renderAmbientCalendar',
    '_updateAmbientPersonalization', '_updateAmbientCard', '_refreshAssistantHome', '_assistantClientIsActive',
    '_startAssistantHomeRefresh', '_stopAssistantHomeRefresh', '_restartUpdateTimer', '_handleAssistantError', 'disable',
    '_buildTodayPage', '_createAssistantPage', '_createAssistantSectionTitle', '_addAssistantPageRow',
    '_selectAssistantCalendarDate', '_setAssistantPage', '_renderAssistantCurrentPage', '_updateAssistantPagerControls', '_handleInteractionKey', '_setInteractionSection'];
const Hud = Function('St', 'GLib', 'Clutter', 'Pango', 'compactText', 'greetingForHour', 'selectDailyVerse',
    'calendarDateKey', 'createCalendar', 'updateCalendar', 'eventsOnCalendarDate', 'global', 'Main', 'log', 'logError', 'Date',
    `return class Hud {${methods.map(method).join('\n')}}`)(St, GLib, Clutter, Pango, compactText, greetingForHour, selectDailyVerse,
    calendarDateKey, createCalendar, updateCalendar, eventsOnCalendarDate, globalShim, Main, () => {}, error => {throw error;}, HudDate);
const values = {'display-name': 'Stan', 'show-daily-verse': true};
function makeHud(home = null, build = true) {
    const hud = new Hud();
    Object.assign(hud, {
        _hud: new Actor(), _assistantHome: home, _assistantConnection: home ? 'online' : 'unknown',
        _assistantTasksLoaded: false, _taskState: {tasks: [{title: 'STALE LOCAL TASK'}]},
        _calendarEvents: [], _dailyVerses: verses, _dailyVerse: null, _ambientVerseDay: null,
        _settings: {get_string: (key) => values[key], get_boolean: (key) => values[key], get_int: () => 1},
        _ambientCard: {titleLabel: new Actor(), body: new Actor(), destroy() {this.body.destroy();}},
        _getAssistantRailGeometry: () => ({width: 358, height: 748}),
        _getAttentionCommsEntries: () => [], _isInteractionOpen: () => false, _startupLayoutId: 0,
        _setAssistantConnection(state) { this._assistantConnection = state; },
        _handleAssistantError(_client, error) { throw error; }
    });
    if (build)
        hud._buildAmbientCard();
    return hud;
}
const event = (id, start, end) => ({id, title: id, start, end, all_day: false});
const past = event('Nats Integration Test', '2026-10-06T02:00:00+02:00', '2026-10-06T03:00:00+02:00');
const active = event('Active event', '2026-10-06T03:00:00+02:00', '2026-10-06T04:00:00+02:00');
const future = event('Future event', '2026-10-06T05:00:00+02:00', '2026-10-06T06:00:00+02:00');
const later = event('Later event', '2026-10-06T07:00:00+02:00', '2026-10-06T08:00:00+02:00');
const home = (pending = 1, due = 0, events = [past], next = null) => ({
    tasks: {pending, due_today: due, items: []},
    calendar: {status: 'online', today_count: events.length, events, next, truncated: false}
});

try {
    const hud = makeHud();
    check(hud._ambientVerse.visible && hud._ambientVerseQuote.visible, 'Enabled verse exists without allocation at 1366x768');
    check(hud._ambientVerseHeading.text === 'VERSE' && hud._ambientVerseReference.text.endsWith(' · KJV'), 'Verse heading/reference');
    check(hud._assistantTaskValue.visible && hud._assistantTaskValue.text === 'Loading tasks', 'Startup ignores stale local task');
    const children = hud._ambientCard.body.children;
    check(children.indexOf(hud._ambientVerse) < children.indexOf(hud._assistantNowHeading), 'Verse near date');
    check(children.indexOf(hud._assistantTaskValue) < children.indexOf(hud._ambientCalendar), 'Task counts before month grid');
    check(!hud._assistantEventsValue.visible, 'Missing backend calendar has no fabricated summary');
    const verseActor = hud._ambientVerse, taskActor = hud._assistantTaskValue;
    hud._assistantClient = {getHome: async () => home()};
    await hud._refreshAssistantHome();
    check(hud._assistantTaskValue.text === '1 pending · 0 due today', 'Home arrival sets mandatory counts, independent of items');
    check(hud._assistantEventsValue.visible && hud._assistantEventsValue.text === '1 today', 'Past-only day retains context');
    check(hud._assistantNowValue.text === 'No active focus' && hud._assistantNextValue.text === 'Nothing scheduled', 'Completed event is neither NOW nor NEXT');
    check(!hud._ambientReminderHeading.visible && hud._ambientReminderLabels.length === 0, 'No duplicate empty UPCOMING row');
    check(hud._ambientVerse.visible && hud._ambientVerse === verseActor && hud._assistantTaskValue === taskActor, 'Home arrival preserves verse/static task actor');
    await hud._refreshAssistantHome();
    check(hud._ambientVerse.visible && hud._ambientVerse === verseActor, 'Repeated home refresh preserves verse');
    const early = makeHud(null, false);
    early._assistantClient = {getHome: async () => home()};
    await early._refreshAssistantHome();early._buildAmbientCard();
    check(early._assistantTaskValue.text === '1 pending · 0 due today' && early._ambientVerse.visible,
        'Home arriving before labels is retained by initial build');
    const cache = hud._assistantHome;
    hud._assistantClient = {getHome: async () => home(9)};
    hud._assistantClientIsActive = () => false;
    await hud._refreshAssistantHome();
    check(hud._assistantHome === cache, 'Inactive-client lifecycle guard preserved');

    const zero = makeHud(home(0, 0, []));
    check(zero._assistantTaskValue.text === 'No pending tasks' && zero._assistantEventsValue.text === '0 today', 'Zero tasks/events');
    check(makeHud(home(4, 2))._assistantTaskValue.text === '4 pending · 2 due today', 'Due-today counts');
    const live = makeHud(home(1, 0, [past, active, future, later], future));
    check(live._assistantNowValue.text === '03:00 Active event', 'NOW only active event');
    check(live._assistantNextValue.text === '05:00 Future event', 'Backend future NEXT');
    check(live._ambientReminderLabels.length === 1 && live._ambientReminderLabels[0].text === '07:00 Later event', 'UPCOMING excludes NOW/NEXT');
    const staleNext = makeHud(home(1, 0, [past], past));
    check(staleNext._assistantNextValue.text === 'Nothing scheduled', 'Reject stale completed backend next');
    clock = new Date('2026-10-06T05:00:00+02:00');
    live._renderAmbientEvents();
    check(live._assistantNowValue.text === '05:00 Future event' && live._assistantNextValue.text === 'Nothing scheduled', 'NEXT becomes NOW without duplicate');

    for (const status of ['offline', 'not_connected', 'error']) {
        live._assistantHome.calendar.status = status;
        live._renderAmbientEvents();
        check(!live._assistantNextValue.text.includes('Future event') && live._assistantEventsValue.text.startsWith('Calendar'), `Controlled calendar ${status}`);
        check(live._ambientVerse.visible && live._assistantTaskValue.text === '1 pending · 0 due today', `Calendar ${status} preserves other sections`);
    }
    const offline = makeHud();
    offline._assistantConnection = 'offline';offline._renderAmbientEvents();
    check(offline._assistantTaskValue.text === 'Assistant offline' && offline._ambientVerse.visible, 'Assistant offline without home');
    const cached = makeHud(home());cached._assistantConnection = 'offline';cached._renderAmbientEvents();
    check(cached._assistantEventsValue.text === 'Calendar offline' && cached._assistantTaskValue.text === '1 pending · 0 due today', 'Connection failure suppresses stale calendar, retains task counts');
    const fallback = makeHud();fallback._calendarEvents = [future, later];fallback._renderAmbientEvents();
    check(fallback._assistantNextValue.text.includes('Later event') && fallback._ambientReminderLabels.length === 0,
        'Local compatibility fallback never duplicates NEXT at the current clock');

    values['show-daily-verse'] = false;hud._updateAmbientPersonalization();
    check(!hud._ambientVerse.visible, 'Verse off immediately');
    values['show-daily-verse'] = true;hud._updateAmbientPersonalization();
    check(hud._ambientVerse.visible, 'Verse on immediately');
    values['display-name'] = '';hud._updateAmbientPersonalization();
    check(hud._ambientCard.titleLabel.text === 'GOOD MORNING', 'Blank name has no punctuation');
    values['display-name'] = 'Long Name '.repeat(40);hud._updateAmbientPersonalization();
    check(hud._ambientCard.titleLabel.text.length < 60, 'Long display name bounded');
    values['display-name'] = 'Stan';
    const long = makeHud();long._dailyVerses = [{...verses[0], text: 'A long verse '.repeat(100)}];long._ambientVerseDay = null;
    long._updateAmbientPersonalization();
    check(Array.from(long._ambientVerseQuote.text).length === 101 && long._ambientVerseQuote.singleLine && !long._ambientVerseQuote.wrap, 'Long quote bounded with ellipsis');
    long._getAssistantRailGeometry = () => ({width: 150, height: 748});long._updateAmbientPersonalization();
    check(long._ambientVerse.visible && !long._ambientVerseQuote.visible && long._ambientVerseReference.visible, 'Narrow reference-only');
    long._getAssistantRailGeometry = () => ({width: 358, height: 300});long._updateAmbientPersonalization();
    check(long._ambientVerse.visible && !long._ambientVerseQuote.visible, 'Short work area retains reference');
    long._dailyVerses = [];long._ambientVerseDay = null;long._updateAmbientPersonalization();
    check(!long._ambientVerse.visible && long._ambientCard.titleLabel.text === 'GOOD MORNING, STAN', 'Empty dataset preserves greeting');
    check(loadVerses({load_contents: () => { throw Error('Missing'); }}).length === 0, 'Missing asset graceful');
    check(loadVerses({load_contents: () => [true, new TextEncoder().encode('broken')]}).length === 0, 'Invalid asset graceful');
    check(verses.length === 16 && verses.every(v => v.reference && v.text && v.translation === 'KJV'), 'Offline dataset has quotes/references');
    check(selectDailyVerse('2026-10-06', verses).id === selectDailyVerse('2026-10-06', structuredClone(verses)).id, 'Deterministic reboot selection');
    for (const [time, period] of [['04:59','EVENING'],['05:00','MORNING'],['11:59','MORNING'],['12:00','AFTERNOON'],['16:59','AFTERNOON'],['17:00','EVENING']]) {
        clock = new Date(`2026-10-06T${time}:00+02:00`);hud._updateAmbientCard();
        check(hud._ambientCard.titleLabel.text === `GOOD ${period}, STAN`, `Actual update boundary ${time}`);
    }
    clock = new Date('2026-10-06T23:59:00+02:00');hud._updateAmbientPersonalization();const previous = hud._dailyVerse.id;
    clock = new Date('2026-10-06T22:00:00Z');hud._updateAmbientPersonalization();
    check(hud._ambientVerseDay === '2026-10-07' && hud._dailyVerse.id !== previous, 'Local midnight changes verse before UTC date');

    clock = new Date('2026-10-06T03:10:00+02:00');
    const polling = makeHud();
    let homeCalls = 0, telemetryTicks = 0, disposed = false;
    polling._assistantClient = {getHome: async () => {homeCalls++;return home(homeCalls);}, dispose() {disposed = true;}};
    polling._startAssistantHomeRefresh();polling._startAssistantHomeRefresh();
    await polling._assistantHomeRequest.promise;
    check(sources.size === 1 && [...sources.values()][0].seconds === 45 && homeCalls === 1, 'One 45-second source plus initial passive fetch');
    check(polling._assistantTaskValue.text === '1 pending · 0 due today', 'Initial fetch without interaction');
    sources.get(polling._assistantHomeRefreshId).callback();await polling._assistantHomeRequest.promise;
    check(homeCalls === 2 && polling._assistantTaskValue.text === '2 pending · 0 due today', 'Passive recurring refresh without interaction');
    polling._updateMetrics = () => {telemetryTicks++;};polling._restartUpdateTimer();
    polling._handleAssistantError = Hud.prototype._handleAssistantError;
    polling._assistantClient.getHome = async () => {throw Object.assign(Error('Offline'), {kind: 'offline'});};
    sources.get(polling._assistantHomeRefreshId).callback();await polling._assistantHomeRequest.promise;
    sources.get(polling._timer).callback();
    check(polling._assistantConnection === 'offline' && telemetryTicks === 1 && sources.size === 2, 'Backend outage leaves independent telemetry source running');
    polling.disable();
    check(sources.size === 0 && polling._assistantHomeRefreshId === 0 && disposed, 'Disable removes assistant and telemetry sources/disposes client');
    check(extension.includes('this._startAssistantHomeRefresh();') && !method('_updateMetrics').includes('_refreshAssistantHome'), 'Enable starts cadence; telemetry never fetches home');

    const overlap = makeHud();let inFlight = 0, maxInFlight = 0;const pending = [];
    overlap._assistantClient = {getHome: () => {
        inFlight++;maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise(resolve => pending.push(resolve)).then(value => {inFlight--;return value;});
    }};
    const firstFetch = overlap._refreshAssistantHome(), secondFetch = overlap._refreshAssistantHome(0), thirdFetch = overlap._refreshAssistantHome();
    check(pending.length === 1, 'Concurrent triggers share running home request');
    pending[0](home(1));await Promise.resolve();await Promise.resolve();
    check(pending.length === 2 && maxInFlight === 1, 'Overlaps coalesce into one sequential follow-up');
    pending[1](home(2));await Promise.all([firstFetch, secondFetch, thirdFetch]);
    check(overlap._assistantHomeRequest === null && overlap._assistantHome.tasks.pending === 2, 'Follow-up applies latest state and clears request');
    const late = makeHud();let lateResolve, lateCalls = 0;
    late._assistantClient = {getHome: () => {lateCalls++;return new Promise(resolve => {lateResolve = resolve;});}, dispose() {}};
    late._startAssistantHomeRefresh();
    const lateRequest = late._assistantHomeRequest.promise, queuedLate = late._refreshAssistantHome();
    late.disable();lateResolve(home(99));await Promise.all([lateRequest, queuedLate]);
    check(late._assistantHome === null && lateCalls === 1 && sources.size === 0, 'Disable blocks late reply and queued follow-up without leaking source');

    const loadedDay = event('Loaded Oct 8 event', '2026-10-08T12:00:00+02:00', '2026-10-08T13:00:00+02:00');
    const compact = createCalendar({compact: true}), full = createCalendar();
    const clicked = [];
    updateCalendar(compact, {today: clock, events: [past, loadedDay]});
    updateCalendar(full, {today: clock, events: [past, loadedDay], selectedDate: '2026-10-06', onSelect: key => clicked.push(key)});
    const flatten = actor => [actor, ...actor.children.flatMap(flatten)];
    check(flatten(compact).filter(a => a.style_class?.includes('nats-calendar-today')).length === 1 &&
        flatten(full).filter(a => a.style_class?.includes('nats-calendar-today')).length === 1, 'Shared current-day highlight in both calendars');
    check(flatten(compact).filter(a => a.text === '●').length === 2 && flatten(full).filter(a => a.text === '●').length === 2, 'Shared event markers');
    check(compact.monthLabel.text === full.monthLabel.text && compact.weekdayRow.children.map(a => a.text).join() === 'Mo,Tu,We,Th,Fr,Sa,Su', 'Shared month formatting/weekday order');
    const gridRow = compact.grid.children[0];updateCalendar(compact, {today: clock, events: [past, loadedDay]});
    check(compact.grid.children[0] === gridRow && compact.dayButtons.size === 0, 'Passive grid is noninteractive and avoids unchanged rebuilds');
    const span = event('All-day span', '2026-10-05T00:00:00+02:00', '2026-10-07T00:00:00+02:00');
    check(eventsOnCalendarDate([span], '2026-10-06').length === 1 && eventsOnCalendarDate([span], '2026-10-07').length === 0, 'Shared overlap uses exclusive end');
    full.dayButtons.get('2026-10-08').emit('clicked');
    full.dayButtons.get('2026-10-06').emit('key-press-event', {get_key_symbol: () => Clutter.KEY_Return});
    full.dayButtons.get('2026-10-09').emit('key-press-event', {get_key_symbol: () => Clutter.KEY_space});
    check(clicked.join() === '2026-10-08,2026-10-06,2026-10-09', 'Click/Enter/Space select valid days');

    const interactive = makeHud(home(1, 0, [past], loadedDay));
    interactive._isInteractionOpen = () => true;interactive._activeSection = 'control';interactive._assistantPage = 0;
    interactive._assistantSelectedDate = '2026-10-06';interactive._interactionPanel = new Actor();
    interactive._assistantPageHost = new Actor();interactive._interactionPanel.add_child(interactive._assistantPageHost);
    interactive._updateAssistantTasksPage = () => false;interactive._buildTasksPage = () => new Actor();interactive._buildAssistantPage = () => new Actor();
    interactive._renderAssistantCurrentPage();
    interactive._selectAssistantCalendarDate('2026-10-08');
    check(interactive._assistantSelectedDate === '2026-10-08' && flatten(interactive._assistantPageActor).some(a => a.text === 'EVENTS · 08 OCT') &&
        flatten(interactive._assistantPageActor).some(a => a.text.includes('Loaded Oct 8 event')), 'Selected backend lookahead day displays event preview');
    check(interactive._assistantTodayCalendar.dayButtons.get('2026-10-08').style_class.includes('nats-calendar-selected') &&
        interactive._assistantTodayCalendar.dayButtons.get('2026-10-06').style_class.includes('nats-calendar-today'), 'Selected and today states coexist');
    interactive._assistantClient = {getHome: async () => home(1, 0, [past], loadedDay)};
    await interactive._refreshAssistantHome();
    check(interactive._assistantSelectedDate === '2026-10-08' && stageFocus === interactive._assistantTodayCalendar.dayButtons.get('2026-10-08'),
        'Home rerender preserves selected date and calendar keyboard focus');
    interactive._selectAssistantCalendarDate('2026-10-09');
    check(flatten(interactive._assistantPageActor).some(a => a.text === 'No loaded events'), 'Unknown selected day is honest');
    interactive._selectAssistantCalendarDate('2026-10-06');
    check(flatten(interactive._assistantPageActor).some(a => a.text === "TODAY'S EVENTS") && clock.getDate() === 6, 'Selecting today restores heading without changing system date');
    for (const name of ['_assistantPrevButton', '_assistantNextButton', '_assistantDot0Button', '_assistantDot1Button', '_assistantDot2Button'])
        interactive[name] = new St.Button();
    interactive._refreshAssistantHome = () => {};interactive._refreshAssistantTasks = () => {};
    const key = symbol => ({type: () => Clutter.EventType.KEY_PRESS, get_key_symbol: () => symbol});
    stageFocus = interactive._interactionPanel;
    check(interactive._handleInteractionKey(key(Clutter.KEY_Right)) === Clutter.EVENT_STOP && interactive._assistantPage === 1 && interactive._assistantDot1Button.label === '●', 'Right Arrow uses pager/dots');
    interactive._handleInteractionKey(key(Clutter.KEY_Left));
    check(interactive._assistantPage === 0 && interactive._assistantDot0Button.label === '●', 'Left Arrow uses pager/dots');
    interactive._handleInteractionKey(key(Clutter.KEY_Left));interactive._setAssistantPage(2);interactive._handleInteractionKey(key(Clutter.KEY_Right));
    check(interactive._assistantPage === 2 && !interactive._assistantNextButton.reactive, 'Arrows preserve clamped pager bounds');
    interactive._setInteractionSection = Hud.prototype._setInteractionSection;
    interactive._renderInteractionSection = section => {interactive._activeSection = section;};
    interactive._setInteractionSection('cpu');interactive._setInteractionSection('control');
    check(interactive._assistantPage === 2, 'Focus view/BACK preserves assistant page');
    interactive._isInteractionOpen = () => false;
    check(interactive._handleInteractionKey(key(Clutter.KEY_Left)) === Clutter.EVENT_PROPAGATE && interactive._assistantPage === 2, 'No paging outside interactive mode');
    interactive._isInteractionOpen = () => true;stageFocus = new Actor();
    check(interactive._handleInteractionKey(key(Clutter.KEY_Left)) === Clutter.EVENT_PROPAGATE, 'No paging outside panel focus');
    const entry = new St.Entry();interactive._interactionPanel.add_child(entry);stageFocus = entry;
    check(interactive._handleInteractionKey(key(Clutter.KEY_Left)) === Clutter.EVENT_PROPAGATE, 'Editable control retains arrows');
    const text = new Clutter.Text({editable: true});interactive._interactionPanel.add_child(text);stageFocus = text;
    check(interactive._handleInteractionKey(key(Clutter.KEY_Left)) === Clutter.EVENT_PROPAGATE, 'Editable text retains arrows');
    interactive._setAssistantPage(0);
    const dayButton = interactive._assistantTodayCalendar.dayButtons.get('2026-10-08');interactive._interactionPanel.add_child(dayButton);stageFocus = dayButton;
    check(interactive._handleInteractionKey(key(Clutter.KEY_Right)) === Clutter.EVENT_PROPAGATE && interactive._assistantPage === 0, 'Calendar focus retains arrows');
    let closed = false;interactive._hideInteractionPanel = () => {closed = true;};
    check(interactive._handleInteractionKey(key(Clutter.KEY_Escape)) === Clutter.EVENT_STOP && closed, 'Escape close preserved');

    const schema = new Map([...read('schemas/org.gnome.shell.extensions.nats-hud.gschema.xml').matchAll(/<key name="([^"]+)" type="([^"]+)"/g)].map(m => [m[1], m[2]]));
    const prefs = read('prefs.js');
    const referenced = new Set();
    for (const source of [extension, prefs]) {
        for (const match of source.matchAll(/(?:get|set)_(boolean|double|int|string)\('([^']+)'/g)) {
            const type = {boolean: 'b', double: 'd', int: 'i', string: 's'}[match[1]];
            check(schema.get(match[2]) === type, `Typed settings parity: ${match[2]}`);referenced.add(match[2]);
        }
        for (const match of source.matchAll(/\['(show-[^']+)'\s*,/g)) {
            check(schema.get(match[1]) === 'b', `Dynamic visibility parity: ${match[1]}`);referenced.add(match[1]);
        }
    }
    check(schema.get('display-name') === 's' && schema.get('show-daily-verse') === 'b' && schema.get('toggle-interactive-mode') === 'as', 'Personalization/shortcut types');
    check(prefs.includes("settings.bind('display-name'") && extension.includes("key === 'display-name' || key === 'show-daily-verse'"), 'Live settings binding/signal');
    for (const key of ['show-actions', 'toggle-interactive-mode']) referenced.add(key);
    check([...schema.keys()].every(key => referenced.has(key)), 'Every schema key accounted for');
    console.log(`${checks} passive overview/settings checks passed`);
} finally {
    Date.now = originalNow;
}
