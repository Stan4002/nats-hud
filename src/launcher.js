import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function reportError(message, error) {
	logError(error, `NATS HUD: ${message}`);
}

function isStringArray(value) {
	return Array.isArray(value) && [...value].every(argument => typeof argument === 'string');
}

export function launchCommand(argv) {
	if (!isStringArray(argv) || argv.length === 0 || argv[0].length === 0) {
		reportError('Cannot launch command: argv must be a non-empty array of strings',
			new TypeError('Invalid argv'));
		return null;
	}

	const command = [...argv];

	try {
		const process = Gio.Subprocess.new(command, Gio.SubprocessFlags.NONE);

		process.wait_check_async(null, (subprocess, result) => {
			try {
				subprocess.wait_check_finish(result);
			} catch (error) {
				reportError(`Command failed: ${command[0]}`, error);
			}
		});

		return process;
	} catch (error) {
		reportError(`Unable to launch command: ${command[0]}`, error);
		return null;
	}
}

export function launchApplication(executable, args = []) {
	if (typeof executable !== 'string' || executable.length === 0 || !isStringArray(args)) {
		reportError('Cannot launch application: executable and args must be strings',
			new TypeError('Invalid application arguments'));
		return null;
	}

	let resolvedExecutable = executable;
	if (executable === 'nats-assistant') {
		const homeDir = GLib.get_home_dir();
		const candidates = [
			GLib.find_program_in_path(executable),
			GLib.build_filenamev([homeDir, '.local', 'bin', executable]),
			GLib.build_filenamev([homeDir, 'Projects', 'nats-assistant', '.venv', 'bin', executable])
		];
		resolvedExecutable = candidates.find(path => path &&
			GLib.file_test(path, GLib.FileTest.IS_REGULAR) &&
			GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE));
		if (!resolvedExecutable) {
			reportError('Cannot launch nats-assistant: no executable found in PATH, ~/.local/bin, or ~/Projects/nats-assistant/.venv/bin',
				new Error('nats-assistant executable is unavailable'));
			return null;
		}
		resolvedExecutable = GLib.canonicalize_filename(resolvedExecutable, null);
	}

	return launchCommand([resolvedExecutable, ...args]);
}

export function launchTerminal(commandArgs = []) {
	if (!isStringArray(commandArgs)) {
		reportError('Cannot launch terminal: commandArgs must be an array of strings',
			new TypeError('Invalid terminal arguments'));
		return null;
	}

	const terminalArgs = commandArgs.length > 0
		? ['--', ...commandArgs]
		: [];

	return launchApplication('gnome-terminal', terminalArgs);
}

export function openBtop() {
	return launchTerminal(['btop']);
}

export function openSystemMonitor() {
	return launchApplication('gnome-system-monitor');
}

export function openFiles() {
	return launchApplication('nautilus');
}

export function openTerminal() {
	return launchTerminal();
}

export function openCode(projectPath = null) {
	const args = projectPath === null ? [] : [projectPath];

	return launchApplication('code', args);
}
