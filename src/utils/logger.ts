import { env } from "../config/env";

type LogFields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", message: string, fields: LogFields = {}) {
	const entry = { timestamp: new Date().toISOString(), level, message, ...fields };
	const line = JSON.stringify(entry);
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.info(line);
}

export const logger = {
	info: (message: string, fields?: LogFields) => write("info", message, fields),
	warn: (message: string, fields?: LogFields) => write("warn", message, fields),
	error: (message: string, fields?: LogFields) => write("error", message, fields),
	formatError(error: unknown) {
		if (!(error instanceof Error)) return { error: String(error) };
		return {
			errorName: error.name,
			errorMessage: error.message,
			...(env.nodeEnv !== "production" && error.stack ? { stack: error.stack } : {}),
		};
	},
};
