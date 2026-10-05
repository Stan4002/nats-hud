import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {clamp, makeSparkline} from './formatters.js';

function toDisplayText(value) {
	if (value === null || value === undefined)
		return '--';

	if (typeof value === 'number' && !Number.isFinite(value))
		return '--';

	return String(value);
}

export const GlassCard = GObject.registerClass({
	GTypeName: 'NatsHudGlassCard'
}, class GlassCard extends St.BoxLayout {
	constructor({title = '', subtitle = null, iconText = null, reactive = true} = {}) {
		super({
			vertical: true,
			style_class: 'nats-glass-card',
			reactive,
			track_hover: reactive,
			can_focus: reactive
		});

		const header = new St.BoxLayout({
			style_class: 'nats-card-header',
			x_expand: true
		});

		if (iconText !== null && iconText !== undefined && iconText !== '') {
			this.iconLabel = new St.Label({
				text: toDisplayText(iconText),
				style_class: 'nats-card-icon',
				y_align: Clutter.ActorAlign.CENTER
			});
			header.add_child(this.iconLabel);
		}

		const heading = new St.BoxLayout({
			vertical: true,
			style_class: 'nats-card-heading',
			x_expand: true
		});

		this.titleLabel = new St.Label({
			text: toDisplayText(title),
			style_class: 'nats-card-title',
			x_expand: true
		});
		heading.add_child(this.titleLabel);

		if (subtitle !== null && subtitle !== undefined && subtitle !== '') {
			this.subtitleLabel = new St.Label({
				text: toDisplayText(subtitle),
				style_class: 'nats-card-subtitle',
				x_expand: true
			});
			heading.add_child(this.subtitleLabel);
		}

		header.add_child(heading);
		this.add_child(header);

		this.body = new St.BoxLayout({
			vertical: true,
			style_class: 'nats-card-body',
			x_expand: true
		});
		this.add_child(this.body);
	}
});

export const MetricValue = GObject.registerClass({
	GTypeName: 'NatsHudMetricValue'
}, class MetricValue extends St.BoxLayout {
	constructor({value = '--', label = '', stateClass = null} = {}) {
		super({
			vertical: true,
			style_class: 'nats-metric-value',
			x_expand: true
		});

		this.valueLabel = new St.Label({
			text: toDisplayText(value),
			style_class: 'nats-metric-main',
			x_expand: true
		});
		this.secondaryLabel = new St.Label({
			text: toDisplayText(label),
			style_class: 'nats-metric-label',
			x_expand: true
		});

		this.add_child(this.valueLabel);
		this.add_child(this.secondaryLabel);
		this._stateClass = null;
		this.setState(stateClass);
	}

	update(value) {
		this.valueLabel.text = toDisplayText(value);
	}

	setState(stateClass) {
		if (this._stateClass)
			this.remove_style_class_name(this._stateClass);

		this._stateClass = typeof stateClass === 'string' && stateClass.length > 0
			? stateClass
			: null;

		if (this._stateClass)
			this.add_style_class_name(this._stateClass);
	}
});

const ProgressTrack = GObject.registerClass({
	GTypeName: 'NatsHudProgressTrack'
}, class ProgressTrack extends St.Widget {
	constructor(percent = 0) {
		super({style_class: 'nats-progress-track', x_expand: true});
		this._percent = clamp(percent, 0, 100);
		this.fill = new St.Widget({style_class: 'nats-progress-fill'});
		this.add_child(this.fill);
	}

	setPercent(percent) {
		const next = clamp(percent, 0, 100);
		if (next === this._percent)
			return;

		this._percent = next;
		this.queue_relayout();
	}

	vfunc_allocate(box) {
		this.set_allocation(box);
		const fillBox = this.get_theme_node().get_content_box(box);
		fillBox.x2 = fillBox.x1 + (fillBox.x2 - fillBox.x1) * this._percent / 100;
		this.fill.allocate(fillBox);
	}
});

export const ProgressMetric = GObject.registerClass({
	GTypeName: 'NatsHudProgressMetric'
}, class ProgressMetric extends St.BoxLayout {
	constructor({label = '', percent = 0, text = '--'} = {}) {
		super({
			vertical: true,
			style_class: 'nats-progress-metric',
			x_expand: true
		});

		const header = new St.BoxLayout({
			style_class: 'nats-progress-header',
			x_expand: true
		});
		this.labelLabel = new St.Label({
			text: toDisplayText(label),
			style_class: 'nats-progress-label',
			x_expand: true
		});
		this.valueLabel = new St.Label({
			text: toDisplayText(text),
			style_class: 'nats-progress-value',
			x_align: Clutter.ActorAlign.END
		});
		header.add_child(this.labelLabel);
		header.add_child(this.valueLabel);

		this.progressTrack = new ProgressTrack(percent);
		this.progressFill = this.progressTrack.fill;

		this.add_child(header);
		this.add_child(this.progressTrack);
		this.update(percent, text);
	}

	update(percent, text) {
		this.progressTrack.setPercent(percent);
		this.valueLabel.text = toDisplayText(text);
	}
});

export const SparklineLabel = GObject.registerClass({
	GTypeName: 'NatsHudSparklineLabel'
}, class SparklineLabel extends St.Label {
	constructor(values = [], maxValue = 100) {
		super({
			style_class: 'nats-sparkline',
			x_expand: true
		});

		this.update(values, maxValue);
	}

	update(values, maxValue = 100) {
		this.text = makeSparkline(values, maxValue);
	}
});

export const SectionHeader = GObject.registerClass({
	GTypeName: 'NatsHudSectionHeader'
}, class SectionHeader extends St.Label {
	constructor(text = '') {
		super({
			text: toDisplayText(text),
			style_class: 'nats-section-header',
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER
		});
	}

	update(text) {
		this.text = toDisplayText(text);
	}
});
