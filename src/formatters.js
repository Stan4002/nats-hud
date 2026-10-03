const INVALID_VALUE = '--';
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const SPARKLINE_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function clamp(value, min, max) {
	if (!Number.isFinite(min) || !Number.isFinite(max))
		return 0;

	const lowerBound = Math.min(min, max);
	const upperBound = Math.max(min, max);
	const numericValue = Number.isFinite(value) ? value : lowerBound;

	return Math.min(Math.max(numericValue, lowerBound), upperBound);
}

export function formatPercent(value, decimals = 0) {
	if (!Number.isFinite(value))
		return INVALID_VALUE;

	const decimalPlaces = Number.isFinite(decimals)
		? clamp(Math.trunc(decimals), 0, 6)
		: 0;

	return `${clamp(value, 0, 100).toFixed(decimalPlaces)}%`;
}

export function formatBytes(bytes) {
	if (!Number.isFinite(bytes))
		return INVALID_VALUE;

	const sign = bytes < 0 ? '-' : '';
	let magnitude = Math.abs(bytes);
	let unitIndex = 0;

	while (magnitude >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
		magnitude /= 1024;
		unitIndex++;
	}

	if (unitIndex === 0)
		return `${sign}${Math.round(magnitude)} ${BYTE_UNITS[unitIndex]}`;

	let roundedMagnitude = Math.round(magnitude * 10) / 10;
	if (roundedMagnitude >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
		roundedMagnitude /= 1024;
		unitIndex++;
	}

	return `${sign}${roundedMagnitude.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatBytesPerSecond(bytesPerSecond) {
	const formattedBytes = formatBytes(bytesPerSecond);

	return formattedBytes === INVALID_VALUE
		? INVALID_VALUE
		: `${formattedBytes}/s`;
}

export function formatDuration(seconds) {
	if (!Number.isFinite(seconds))
		return INVALID_VALUE;

	const totalSeconds = Math.floor(Math.max(0, seconds));
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainingSeconds = totalSeconds % 60;

	if (days > 0)
		return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0)
		return `${hours}h ${minutes}m`;
	if (minutes > 0)
		return `${minutes}m ${remainingSeconds}s`;

	return `${remainingSeconds}s`;
}

export function formatTemperature(celsius) {
	if (!Number.isFinite(celsius))
		return INVALID_VALUE;

	return `${celsius.toFixed(1)}°C`;
}

export function formatLoad(value) {
	if (!Number.isFinite(value))
		return INVALID_VALUE;

	return Math.max(0, value).toFixed(2);
}

export function makeTextBar(percent, length = 12) {
	const barLength = Number.isFinite(length)
		? clamp(Math.trunc(length), 0, 80)
		: 12;
	const filledLength = Math.round(clamp(percent, 0, 100) * barLength / 100);

	return '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
}

export function makeSparkline(values, maxValue = 100) {
	if (!Array.isArray(values))
		return '';

	const scaleMaximum = Number.isFinite(maxValue) && maxValue > 0
		? maxValue
		: 100;

	return values.map(value => {
		const scaledValue = clamp(value, 0, scaleMaximum) / scaleMaximum;
		const level = Math.round(scaledValue * (SPARKLINE_LEVELS.length - 1));

		return SPARKLINE_LEVELS[level];
	}).join('');
}
