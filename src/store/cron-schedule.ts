import type { SessionCronRecord } from "../types.js";

export function getServerTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function normalizeTimezone(timezone: string | undefined): string {
	const candidate = timezone?.trim() || getServerTimezone();
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
		return candidate;
	} catch {
		throw new Error(`Invalid timezone "${candidate}"`);
	}
}

export function validateRunAtLocal(runAtLocal: string): string {
	const normalized = runAtLocal.trim();
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
		throw new Error("runAtLocal must look like YYYY-MM-DDTHH:mm");
	}
	return normalized;
}

export function validateDailyTimePart(name: "hour" | "minute", value: number, maxInclusive: number): number {
	if (!Number.isInteger(value) || value < 0 || value > maxInclusive) {
		throw new Error(`${name} must be an integer between 0 and ${maxInclusive}`);
	}
	return value;
}

function getZonedDateTimeParts(date: Date, timeZone: string): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
} {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = formatter.formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const value = parts.find((part) => part.type === type)?.value;
		return value ? Number.parseInt(value, 10) : 0;
	};
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: get("hour"),
		minute: get("minute"),
		second: get("second"),
	};
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
	const parts = getZonedDateTimeParts(date, timeZone);
	const utcFromZoneClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	return utcFromZoneClock - date.getTime();
}

function zonedLocalToUtc(local: {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}, timeZone: string): Date {
	let utcMillis = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const offset = getTimeZoneOffsetMs(new Date(utcMillis), timeZone);
		const next = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0) - offset;
		if (next === utcMillis) {
			break;
		}
		utcMillis = next;
	}
	return new Date(utcMillis);
}

function addLocalDays(local: { year: number; month: number; day: number }, days: number): {
	year: number;
	month: number;
	day: number;
} {
	const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days, 12, 0, 0));
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
	};
}

function parseRunAtLocalParts(runAtLocal: string): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
} {
	const normalized = validateRunAtLocal(runAtLocal);
	const [datePart, timePart] = normalized.split("T");
	const [year, month, day] = datePart.split("-").map((value) => Number.parseInt(value, 10));
	const [hour, minute] = timePart.split(":").map((value) => Number.parseInt(value, 10));
	return { year, month, day, hour, minute };
}

export function computeOnceNextRunAt(runAtLocal: string, timeZone: string): string {
	return zonedLocalToUtc(parseRunAtLocalParts(runAtLocal), timeZone).toISOString();
}

export function computeDailyNextRunAt(hour: number, minute: number, timeZone: string, from: Date = new Date()): string {
	const localNow = getZonedDateTimeParts(from, timeZone);
	const todayCandidate = zonedLocalToUtc(
		{
			year: localNow.year,
			month: localNow.month,
			day: localNow.day,
			hour,
			minute,
		},
		timeZone,
	);
	if (todayCandidate.getTime() > from.getTime()) {
		return todayCandidate.toISOString();
	}
	const tomorrow = addLocalDays(
		{
			year: localNow.year,
			month: localNow.month,
			day: localNow.day,
		},
		1,
	);
	return zonedLocalToUtc(
		{
			...tomorrow,
			hour,
			minute,
		},
		timeZone,
	).toISOString();
}

export function computeCronNextRunAt(input: {
	scheduleKind: SessionCronRecord["scheduleKind"];
	timezone: string;
	runAtLocal?: string;
	hour?: number;
	minute?: number;
	from?: Date;
}): string {
	if (input.scheduleKind === "once") {
		if (!input.runAtLocal) {
			throw new Error("once cron requires runAtLocal");
		}
		return computeOnceNextRunAt(input.runAtLocal, input.timezone);
	}
	if (typeof input.hour !== "number" || typeof input.minute !== "number") {
		throw new Error("daily cron requires hour and minute");
	}
	return computeDailyNextRunAt(input.hour, input.minute, input.timezone, input.from);
}
