import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {clamp, makeSparkline} from './formatters.js';

function toDisplayText(value) {
	if (value === null || value === undefined)
		return '--';

	if (typeof value === 'number' && !Number.isFinite(value))
		return '--';

	return String(value);
}

export class GlassCard extends St.BoxLayout {
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
}

export class MetricValue extends St.BoxLayout {
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
}

export class ProgressMetric extends St.BoxLayout {
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

		this.progressBar = new St.ProgressBar({
			style_class: 'nats-progress-bar',
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER
		});

		this.add_child(header);
		this.add_child(this.progressBar);
		this.update(percent, text);
	}

	update(percent, text) {
		this.progressBar.fraction = clamp(percent, 0, 100) / 100;
		this.valueLabel.text = toDisplayText(text);
	}
}

export class SparklineLabel extends St.Label {
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
}

export class SectionHeader extends St.Label {
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
}
