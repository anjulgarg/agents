import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export interface CodexCredentials {
	access: string;
	accountId?: string;
}

export interface CodexUsageWindow {
	usedPercent?: number;
	remainingPercent?: number;
	durationSeconds?: number;
	resetsAt?: number;
}

export interface CodexAdditionalLimit {
	name: string;
	meteredFeature?: string;
	limitReached?: boolean;
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
}

export interface CodexUsageReport {
	fetchedAt: number;
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
	additionalLimits: CodexAdditionalLimit[];
	resetCreditsAvailable: number;
}

export interface CodexQuota {
	fiveHourRemaining?: number;
	weeklyRemaining?: number;
}

export interface CodexResetCredit {
	id: string;
	status?: string;
	grantedAt?: string;
	expiresAt?: string;
	title?: string;
	description?: string;
}

export interface CodexResetCredits {
	availableCount: number;
	credits: CodexResetCredit[];
}

export interface CodexResetResult {
	ok: boolean;
	code: string;
	status: number;
}

interface CodexUsageClientOptions {
	fetch?: typeof fetch;
	now?: () => number;
	randomUUID?: () => string;
	cacheTtlMs?: number;
	baseUrl?: string;
}

interface UsageReadOptions {
	force?: boolean;
	signal?: AbortSignal;
}

interface UsageCacheEntry {
	accountKey: string;
	expiresAt: number;
	report: CodexUsageReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function parseResetTime(payload: Record<string, unknown>, now: number): number | undefined {
	const resetAt = toFiniteNumber(payload.reset_at);
	if (resetAt !== undefined) return resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
	const resetAfterSeconds = toFiniteNumber(payload.reset_after_seconds);
	return resetAfterSeconds === undefined ? undefined : now + resetAfterSeconds * 1000;
}

function parseUsageWindow(payload: unknown, now: number): CodexUsageWindow | undefined {
	if (!isRecord(payload)) return undefined;
	const used = toFiniteNumber(payload.used_percent);
	const usedPercent = used === undefined ? undefined : clampPercent(used);
	const durationSeconds = toFiniteNumber(payload.limit_window_seconds);
	const resetsAt = parseResetTime(payload, now);
	if (usedPercent === undefined && durationSeconds === undefined && resetsAt === undefined)
		return undefined;
	return {
		usedPercent,
		remainingPercent: usedPercent === undefined ? undefined : 100 - usedPercent,
		durationSeconds,
		resetsAt,
	};
}

function parseRateLimit(
	payload: unknown,
	now: number,
):
	| {
			allowed?: boolean;
			limitReached?: boolean;
			primary?: CodexUsageWindow;
			secondary?: CodexUsageWindow;
	  }
	| undefined {
	if (!isRecord(payload)) return undefined;
	const primary = parseUsageWindow(payload.primary_window, now);
	const secondary = parseUsageWindow(payload.secondary_window, now);
	const allowed = toBoolean(payload.allowed);
	const limitReached = toBoolean(payload.limit_reached);
	if (!primary && !secondary && allowed === undefined && limitReached === undefined)
		return undefined;
	return { allowed, limitReached, primary, secondary };
}

export function codexQuotaFromUsage(report: CodexUsageReport): CodexQuota | undefined {
	const quota: CodexQuota = {};
	for (const [position, window] of [
		["primary", report.primary],
		["secondary", report.secondary],
	] as const) {
		if (window?.remainingPercent === undefined) continue;
		const remaining = Math.round(window.remainingPercent);
		const duration = window.durationSeconds;
		if (duration !== undefined && duration >= 4 * 60 * 60 && duration <= 6 * 60 * 60) {
			quota.fiveHourRemaining = remaining;
		} else if (
			duration !== undefined &&
			duration >= 6 * 24 * 60 * 60 &&
			duration <= 8 * 24 * 60 * 60
		) {
			quota.weeklyRemaining = remaining;
		} else if (duration === undefined) {
			if (position === "primary") quota.fiveHourRemaining = remaining;
			else quota.weeklyRemaining = remaining;
		}
	}
	return quota.fiveHourRemaining === undefined && quota.weeklyRemaining === undefined
		? undefined
		: quota;
}

export function parseCodexUsage(payload: unknown, now = Date.now()): CodexUsageReport | undefined {
	if (!isRecord(payload)) return undefined;
	const rateLimit = parseRateLimit(payload.rate_limit, now);
	const additionalLimits = (
		Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []
	)
		.map((entry): CodexAdditionalLimit | undefined => {
			if (!isRecord(entry)) return undefined;
			const parsed = parseRateLimit(entry.rate_limit, now);
			if (!parsed) return undefined;
			const limitName = toOptionalString(entry.limit_name);
			const meteredFeature = toOptionalString(entry.metered_feature);
			return {
				name: limitName ?? meteredFeature ?? "Additional Codex limit",
				meteredFeature,
				limitReached: parsed.limitReached,
				primary: parsed.primary,
				secondary: parsed.secondary,
			};
		})
		.filter((entry): entry is CodexAdditionalLimit => Boolean(entry));
	const resetBlock = isRecord(payload.rate_limit_reset_credits)
		? payload.rate_limit_reset_credits
		: undefined;
	const available = toFiniteNumber(resetBlock?.available_count) ?? 0;
	if (!rateLimit && additionalLimits.length === 0 && available === 0) return undefined;
	return {
		fetchedAt: now,
		planType: toOptionalString(payload.plan_type),
		allowed: rateLimit?.allowed,
		limitReached: rateLimit?.limitReached,
		primary: rateLimit?.primary,
		secondary: rateLimit?.secondary,
		additionalLimits,
		resetCreditsAvailable: Math.max(0, Math.trunc(available)),
	};
}

function parseCredit(payload: unknown): CodexResetCredit | undefined {
	if (!isRecord(payload)) return undefined;
	const id = toOptionalString(payload.id);
	if (!id) return undefined;
	return {
		id,
		status: toOptionalString(payload.status),
		grantedAt: toOptionalString(payload.granted_at),
		expiresAt: toOptionalString(payload.expires_at),
		title: toOptionalString(payload.title),
		description: toOptionalString(payload.description),
	};
}

export function parseCodexResetCredits(payload: unknown): CodexResetCredits | undefined {
	if (!isRecord(payload)) return undefined;
	const credits = (Array.isArray(payload.credits) ? payload.credits : [])
		.map(parseCredit)
		.filter((credit): credit is CodexResetCredit => Boolean(credit));
	const reportedCount = toFiniteNumber(payload.available_count);
	const availableCount =
		reportedCount === undefined
			? credits.filter((credit) => (credit.status ?? "available") === "available").length
			: Math.max(0, Math.trunc(reportedCount));
	return { availableCount, credits };
}

export function selectResetCredit(report: CodexResetCredits): CodexResetCredit | undefined {
	return report.credits
		.filter((credit) => (credit.status ?? "available") === "available")
		.sort((left, right) => {
			const leftExpiry = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
			const rightExpiry = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
			return leftExpiry - rightExpiry;
		})[0];
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
		const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		return isRecord(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

export function extractCodexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	return isRecord(auth) ? toOptionalString(auth.chatgpt_account_id) : undefined;
}

function findHeader(headers: unknown, target: string): string | undefined {
	if (!isRecord(headers)) return undefined;
	const match = Object.entries(headers).find(([key]) => key.toLowerCase() === target.toLowerCase());
	return toOptionalString(match?.[1]);
}

export async function resolveCodexCredentials(
	ctx: ExtensionContext,
): Promise<CodexCredentials | undefined> {
	try {
		const result = await ctx.modelRegistry.getProviderAuth("openai-codex");
		const access = result?.auth.apiKey;
		if (!access) return undefined;
		const accountId =
			findHeader(result.auth.headers, "chatgpt-account-id") ?? extractCodexAccountId(access);
		return { access, accountId };
	} catch {
		return undefined;
	}
}

export class CodexUsageError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "CodexUsageError";
	}
}

export class CodexUsageClient {
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly randomUUID: () => string;
	private readonly cacheTtlMs: number;
	private readonly baseUrl: string;
	private cache?: UsageCacheEntry;
	private inFlight?: { accountKey: string; request: Promise<CodexUsageReport> };

	constructor(options: CodexUsageClientOptions = {}) {
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.randomUUID = options.randomUUID ?? randomUUID;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.baseUrl = (options.baseUrl ?? CODEX_BACKEND_URL).replace(/\/+$/, "");
	}

	private accountKey(credentials: CodexCredentials): string {
		return credentials.accountId ?? credentials.access;
	}

	private headers(credentials: CodexCredentials, json = false): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${credentials.access}`,
			originator: "pi",
		};
		if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
		if (json) headers["Content-Type"] = "application/json";
		return headers;
	}

	private async readJson(response: Response, action: string): Promise<unknown> {
		if (!response.ok) {
			throw new CodexUsageError(`${action} failed with HTTP ${response.status}.`, response.status);
		}
		try {
			return await response.json();
		} catch {
			throw new CodexUsageError(`${action} returned invalid JSON.`, response.status);
		}
	}

	async getUsage(
		credentials: CodexCredentials,
		options: UsageReadOptions = {},
	): Promise<CodexUsageReport> {
		const now = this.now();
		const accountKey = this.accountKey(credentials);
		if (!options.force && this.cache?.accountKey === accountKey && this.cache.expiresAt > now) {
			return this.cache.report;
		}
		if (!options.force && this.inFlight?.accountKey === accountKey) return this.inFlight.request;

		const request = (async () => {
			const response = await this.fetchImpl(`${this.baseUrl}/wham/usage`, {
				headers: this.headers(credentials),
				signal: options.signal,
			});
			const payload = await this.readJson(response, "Codex usage request");
			const report = parseCodexUsage(payload, this.now());
			if (!report) throw new CodexUsageError("Codex usage response contained no quota data.");
			this.cache = {
				accountKey,
				expiresAt: this.now() + this.cacheTtlMs,
				report,
			};
			return report;
		})();
		this.inFlight = { accountKey, request };
		try {
			return await request;
		} finally {
			if (this.inFlight?.request === request) this.inFlight = undefined;
		}
	}

	async listResetCredits(
		credentials: CodexCredentials,
		signal?: AbortSignal,
	): Promise<CodexResetCredits> {
		const response = await this.fetchImpl(`${this.baseUrl}/wham/rate-limit-reset-credits`, {
			headers: this.headers(credentials),
			signal,
		});
		const payload = await this.readJson(response, "Codex reset-credit request");
		const report = parseCodexResetCredits(payload);
		if (!report) throw new CodexUsageError("Codex reset-credit response was invalid.");
		return report;
	}

	async consumeResetCredit(
		credentials: CodexCredentials,
		creditId: string,
		signal?: AbortSignal,
	): Promise<CodexResetResult> {
		const response = await this.fetchImpl(`${this.baseUrl}/wham/rate-limit-reset-credits/consume`, {
			method: "POST",
			headers: this.headers(credentials, true),
			body: JSON.stringify({
				credit_id: creditId,
				redeem_request_id: this.randomUUID(),
			}),
			signal,
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		const code =
			isRecord(payload) && typeof payload.code === "string"
				? payload.code
				: response.ok
					? "reset"
					: `http_${response.status}`;
		const result = { ok: response.ok && code === "reset", code, status: response.status };
		if (result.ok) this.cache = undefined;
		return result;
	}
}

export const codexUsageClient = new CodexUsageClient();
