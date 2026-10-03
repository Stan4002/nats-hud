import Gio from 'gi://Gio';

function readProcFile(path) {
	const file = Gio.File.new_for_path(path);
	const [, contents] = file.load_contents(null);

	return new TextDecoder('utf-8').decode(contents);
}

function readCpuCounters() {
	const cpuLine = readProcFile('/proc/stat')
		.split('\n')
		.find(line => line.startsWith('cpu '));

	if (!cpuLine)
		throw new Error('Unable to find aggregate CPU counters in /proc/stat');

	const counters = cpuLine.trim().split(/\s+/).slice(1).map(Number);
	const [user, nice, system, idle, ioWait, irq, softIrq, steal] = counters;

	return {
		total: user + nice + system + idle + ioWait + irq + softIrq + steal,
		idle: idle + ioWait
	};
}

function readMemory() {
	const entries = new Map();

	for (const line of readProcFile('/proc/meminfo').split('\n')) {
		const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
		if (match)
			entries.set(match[1], Number(match[2]) * 1024);
	}

	const totalBytes = entries.get('MemTotal');
	const availableBytes = entries.get('MemAvailable');

	if (!totalBytes || availableBytes === undefined)
		throw new Error('Unable to read total and available memory from /proc/meminfo');

	const usedBytes = totalBytes - availableBytes;

	return {
		usedBytes,
		totalBytes,
		availableBytes,
		usagePercent: (usedBytes / totalBytes) * 100
	};
}

export class SystemTelemetry {
	constructor() {
		this._previousCpuCounters = null;
	}

	readSnapshot() {
		const currentCpuCounters = readCpuCounters();
		let cpuUsagePercent = null;

		if (this._previousCpuCounters) {
			const totalDelta = currentCpuCounters.total - this._previousCpuCounters.total;
			const idleDelta = currentCpuCounters.idle - this._previousCpuCounters.idle;

			if (totalDelta > 0)
				cpuUsagePercent = ((totalDelta - idleDelta) / totalDelta) * 100;
		}

		this._previousCpuCounters = currentCpuCounters;

		return {
			cpu: {
				usagePercent: cpuUsagePercent
			},
			memory: readMemory()
		};
	}
}
