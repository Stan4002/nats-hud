import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function readTextFile(path) {
	const file = Gio.File.new_for_path(path);
	const [, contents] = file.load_contents(null);

	return new TextDecoder('utf-8').decode(contents);
}

function readCpuCounters() {
	const countersByCpu = new Map();

	for (const line of readTextFile('/proc/stat').split('\n')) {
		const match = line.match(/^(cpu|cpu\d+)\s+(.+)$/);
		if (!match)
			continue;

		const values = match[2].trim().split(/\s+/).map(Number);
		if (values.length < 4 || !values.every(Number.isFinite))
			continue;

		const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0);
		const idle = values[3] + (values[4] ?? 0);
		countersByCpu.set(match[1], {total, idle});
	}

	if (!countersByCpu.has('cpu'))
		throw new Error('Unable to find aggregate CPU counters in /proc/stat');

	return countersByCpu;
}

function readDirectoryNames(path) {
	let enumerator = null;

	try {
		enumerator = Gio.File.new_for_path(path).enumerate_children(
			'standard::name',
			Gio.FileQueryInfoFlags.NONE,
			null
		);

		const names = [];
		let info;
		while ((info = enumerator.next_file(null)) !== null)
			names.push(info.get_name());

		return names.sort();
	} catch (_error) {
		return [];
	} finally {
		if (enumerator)
			enumerator.close(null);
	}
}

function readOptionalTextFile(path) {
	try {
		return readTextFile(path).trim();
	} catch (_error) {
		return null;
	}
}

function readTemperatureCelsius(path) {
	const rawText = readOptionalTextFile(path);
	if (rawText === null)
		return null;

	const rawValue = Number(rawText);
	if (!Number.isFinite(rawValue))
		return null;

	const celsius = rawValue / 1000;
	return celsius >= -20 && celsius <= 150 ? celsius : null;
}

function readCpuTemperature() {
	const thermalZones = readDirectoryNames('/sys/class/thermal')
		.filter(name => /^thermal_zone\d+$/.test(name))
		.map(name => ({
			name,
			type: readOptionalTextFile(`/sys/class/thermal/${name}/type`) ?? ''
		}))
		.sort((first, second) => {
			const firstIsCpu = /cpu|package|soc|x86/i.test(first.type) ? 0 : 1;
			const secondIsCpu = /cpu|package|soc|x86/i.test(second.type) ? 0 : 1;
			return firstIsCpu - secondIsCpu || first.name.localeCompare(second.name);
		});

	for (const zone of thermalZones) {
		const temperature = readTemperatureCelsius(`/sys/class/thermal/${zone.name}/temp`);
		if (temperature !== null)
			return temperature;
	}

	const hwmonDevices = readDirectoryNames('/sys/class/hwmon')
		.filter(name => /^hwmon\d+$/.test(name));
	const hwmonSensors = [];

	for (const device of hwmonDevices) {
		const devicePath = `/sys/class/hwmon/${device}`;
		const deviceName = readOptionalTextFile(`${devicePath}/name`) ?? '';

		for (const sensorName of readDirectoryNames(devicePath)
			.filter(name => /^temp\d+_input$/.test(name))) {
			const label = readOptionalTextFile(
				`${devicePath}/${sensorName.replace('_input', '_label')}`
			) ?? '';
			hwmonSensors.push({
				path: `${devicePath}/${sensorName}`,
				isCpu: /cpu|package|tctl|tdie/i.test(`${deviceName} ${label}`)
			});
		}
	}

	hwmonSensors.sort((first, second) => Number(second.isCpu) - Number(first.isCpu));
	for (const sensor of hwmonSensors) {
		const temperature = readTemperatureCelsius(sensor.path);
		if (temperature !== null)
			return temperature;
	}

	return null;
}

function readUptimeSeconds() {
	const seconds = Number(readTextFile('/proc/uptime').trim().split(/\s+/)[0]);
	if (!Number.isFinite(seconds) || seconds < 0)
		throw new Error('Unable to read uptime from /proc/uptime');

	return seconds;
}

function readLoadAverage() {
	const values = readTextFile('/proc/loadavg').trim().split(/\s+/).slice(0, 3).map(Number);
	if (values.length !== 3 || !values.every(Number.isFinite))
		throw new Error('Unable to read load averages from /proc/loadavg');

	return {
		oneMinute: values[0],
		fiveMinute: values[1],
		fifteenMinute: values[2]
	};
}

function readNetworkCounters() {
	const candidates = [];

	for (const line of readTextFile('/proc/net/dev').split('\n').slice(2)) {
		const match = line.match(/^\s*([^:]+):\s*(.*)$/);
		if (!match)
			continue;

		const interfaceName = match[1].trim();
		if (interfaceName === 'lo')
			continue;

		const counters = match[2].trim().split(/\s+/).map(Number);
		if (counters.length < 16 || !counters.every(Number.isFinite))
			continue;

		const receiveBytes = counters[0];
		const transmitBytes = counters[8];
		const operstate = readOptionalTextFile(`/sys/class/net/${interfaceName}/operstate`);
		const hasTraffic = receiveBytes + transmitBytes > 0;
		const isUp = operstate === 'up' ||
			((operstate === 'unknown' || operstate === null) && hasTraffic);

		if (isUp) {
			candidates.push({
				interfaceName,
				receiveBytes,
				transmitBytes
			});
		}
	}

	candidates.sort((first, second) =>
		(second.receiveBytes + second.transmitBytes) -
		(first.receiveBytes + first.transmitBytes)
	);

	return candidates[0] ?? null;
}

function readRootFilesystem() {
	try {
		const info = Gio.File.new_for_path('/').query_filesystem_info(
			'filesystem::size,filesystem::free',
			null
		);
		const totalBytes = info.get_attribute_uint64('filesystem::size');
		const freeBytes = info.get_attribute_uint64('filesystem::free');
		if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) ||
			totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes)
			throw new Error('Root filesystem returned invalid capacity values');

		const usedBytes = totalBytes - freeBytes;
		return {
			totalBytes,
			usedBytes,
			freeBytes,
			usagePercent: (usedBytes / totalBytes) * 100
		};
	} catch (_error) {
		return {
			totalBytes: null,
			usedBytes: null,
			freeBytes: null,
			usagePercent: null
		};
	}
}

function readMemory() {
	const entries = new Map();

	for (const line of readTextFile('/proc/meminfo').split('\n')) {
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
		this._previousCpuCounters = new Map();
		this._previousNetworkSample = null;
	}

	readSnapshot() {
		const currentCpuCounters = readCpuCounters();
		const calculateUsage = (name) => {
			const previous = this._previousCpuCounters.get(name);
			const current = currentCpuCounters.get(name);
			if (!previous || !current)
				return null;

			const totalDelta = current.total - previous.total;
			const idleDelta = current.idle - previous.idle;
			if (totalDelta <= 0)
				return null;

			return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
		};

		const cpuUsagePercent = calculateUsage('cpu');
		const cores = [...currentCpuCounters.keys()]
			.filter(name => /^cpu\d+$/.test(name))
			.sort((first, second) => Number(first.slice(3)) - Number(second.slice(3)))
			.map(name => ({
				id: name,
				usagePercent: calculateUsage(name)
			}));

		this._previousCpuCounters = currentCpuCounters;
		const network = this._readNetworkSample();

		return {
			cpu: {
				usagePercent: cpuUsagePercent,
				cores
			},
			memory: readMemory(),
			temperatureCelsius: readCpuTemperature(),
			uptimeSeconds: readUptimeSeconds(),
			loadAverage: readLoadAverage(),
			network,
			storage: readRootFilesystem()
		};
	}

	_readNetworkSample() {
		const current = readNetworkCounters();
		if (!current) {
			this._previousNetworkSample = null;
			return {
				interfaceName: null,
				downloadBytesPerSecond: null,
				uploadBytesPerSecond: null
			};
		}

		const sampledAt = GLib.get_monotonic_time() / 1000000;
		let downloadBytesPerSecond = null;
		let uploadBytesPerSecond = null;
		const previous = this._previousNetworkSample;

		if (previous && previous.interfaceName === current.interfaceName) {
			const elapsedSeconds = sampledAt - previous.sampledAt;
			if (elapsedSeconds > 0) {
				const receivedDelta = current.receiveBytes - previous.receiveBytes;
				const transmittedDelta = current.transmitBytes - previous.transmitBytes;
				if (receivedDelta >= 0)
					downloadBytesPerSecond = receivedDelta / elapsedSeconds;
				if (transmittedDelta >= 0)
					uploadBytesPerSecond = transmittedDelta / elapsedSeconds;
			}
		}

		this._previousNetworkSample = {...current, sampledAt};
		return {
			interfaceName: current.interfaceName,
			downloadBytesPerSecond,
			uploadBytesPerSecond
		};
	}
}
