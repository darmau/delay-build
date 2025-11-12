import {
	DurableObject,
	DurableObjectNamespace,
	type ExecutionContext,
} from "cloudflare:workers";

const STATE_KEY = "scheduler-state";
const DEFAULT_DELAY_MS = 15 * 60 * 1000;
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
};

type BuildStatus = "success" | "error";

type SchedulerState = {
	lastWebhookAt?: number;
	scheduledFor?: number;
	lastBuildAt?: number;
	lastBuildStatus?: BuildStatus;
	lastError?: string;
	retryCount?: number;
	delayMs?: number;
};

type QueueResponse = {
	lastWebhookAt: number;
	scheduledFor: number;
	delayMs: number;
};

type StatusResponse = {
	lastWebhookAt?: string;
	scheduledFor?: string;
	lastBuildAt?: string;
	lastBuildStatus?: BuildStatus;
	lastError?: string;
	retryCount: number;
	delayMs?: number;
};

export class WebhookDelayDurableObject extends DurableObject<Env> {
	async queueBuild(): Promise<QueueResponse> {
		const state = await this.getState();
		const now = Date.now();
		const delayMs = this.resolveDelayMs();
		const scheduledFor = now + delayMs;

		state.lastWebhookAt = now;
		state.scheduledFor = scheduledFor;
		state.retryCount = 0;
		state.delayMs = delayMs;

		await this.setState(state);
		await this.ctx.storage.setAlarm(scheduledFor);

		console.log(
			`Build queued. Next build scheduled at ${new Date(scheduledFor).toISOString()}.`,
		);

		return { lastWebhookAt: now, scheduledFor, delayMs };
	}

	async getStatus(): Promise<StatusResponse> {
		const state = await this.getState();

		return {
			lastWebhookAt: toIso(state.lastWebhookAt),
			scheduledFor: toIso(state.scheduledFor),
			lastBuildAt: toIso(state.lastBuildAt),
			lastBuildStatus: state.lastBuildStatus,
			lastError: state.lastError,
			retryCount: state.retryCount ?? 0,
			delayMs: state.delayMs,
		};
	}

	async alarm(): Promise<void> {
		const state = await this.getState();
		const scheduledFor = state.scheduledFor;

		if (!scheduledFor) {
			return;
		}

		if (!this.env.BUILD_WEBHOOK_URL) {
			console.error("Missing BUILD_WEBHOOK_URL binding.");
			state.lastBuildAt = Date.now();
			state.lastBuildStatus = "error";
			state.lastError = "BUILD_WEBHOOK_URL not configured.";
			state.retryCount = (state.retryCount ?? 0) + 1;
			await this.setState(state);
			return;
		}

		try {
			const response = await fetch(this.env.BUILD_WEBHOOK_URL, {
				method: this.resolveTriggerMethod(),
			});

			if (!response.ok) {
				throw new Error(
					`Build webhook responded with HTTP ${response.status}`,
				);
			}

			console.log("Build webhook triggered successfully.");

			state.lastBuildAt = Date.now();
			state.lastBuildStatus = "success";
			state.lastError = undefined;
			state.retryCount = 0;
			state.scheduledFor = undefined;

			await this.setState(state);
		} catch (error) {
			const now = Date.now();
			const retryCount = (state.retryCount ?? 0) + 1;
			const retryDelayMs = this.getRetryDelayMs(retryCount);
			const nextAlarm = now + retryDelayMs;

			state.lastBuildAt = now;
			state.lastBuildStatus = "error";
			state.lastError = truncateError(error);
			state.retryCount = retryCount;
			state.scheduledFor = nextAlarm;

			await this.setState(state);
			await this.ctx.storage.setAlarm(nextAlarm);

			console.error(
				`Build webhook failed (attempt ${retryCount}). Retrying at ${new Date(
					nextAlarm,
				).toISOString()}.`,
				error,
			);
		}
	}

	private async getState(): Promise<SchedulerState> {
		return (
			(await this.ctx.storage.get<SchedulerState>(STATE_KEY)) ?? {
				retryCount: 0,
			}
		);
	}

	private async setState(state: SchedulerState): Promise<void> {
		await this.ctx.storage.put(STATE_KEY, state);
	}

	private resolveDelayMs(): number {
		const rawSeconds = this.env.BUILD_DELAY_SECONDS;
		if (!rawSeconds) {
			return DEFAULT_DELAY_MS;
		}

		const parsedSeconds = Number.parseInt(rawSeconds, 10);
		if (Number.isNaN(parsedSeconds) || parsedSeconds <= 0) {
			console.warn(
				`Invalid BUILD_DELAY_SECONDS value "${rawSeconds}". Falling back to default.`,
			);
			return DEFAULT_DELAY_MS;
		}

		return parsedSeconds * 1000;
	}

	private resolveTriggerMethod(): "POST" | "GET" {
		const method = this.env.BUILD_TRIGGER_METHOD?.toUpperCase();
		return method === "GET" ? "GET" : "POST";
	}

	private getRetryDelayMs(retryCount: number): number {
		const retryWindowsMs = [60_000, 120_000, 300_000];
		return retryWindowsMs[Math.min(retryCount - 1, retryWindowsMs.length - 1)];
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET,POST,OPTIONS",
					"access-control-allow-headers": "*",
					"access-control-max-age": "86400",
				},
			});
		}

		if (request.method === "GET" && url.pathname === "/status") {
			const stub = env.WEBHOOK_DELAY_DURABLE_OBJECT.getByName("scheduler");
			const status = await stub.getStatus();

			return new Response(JSON.stringify(status), {
				status: 200,
				headers: {
					...JSON_HEADERS,
					"access-control-allow-origin": "*",
				},
			});
		}

		if (request.method !== "POST") {
			return new Response("Not Found", { status: 404 });
		}

		const secret = env.WEBHOOK_SECRET;
		if (secret) {
			const providedSecret =
				request.headers.get("x-webhook-secret") ??
				url.searchParams.get("secret");

			if (providedSecret !== secret) {
				return new Response("Unauthorized", { status: 401 });
			}
		}

		const stub = env.WEBHOOK_DELAY_DURABLE_OBJECT.getByName("scheduler");
		const result = await stub.queueBuild();

		return new Response(
			JSON.stringify({
				ok: true,
				scheduledFor: new Date(result.scheduledFor).toISOString(),
				delaySeconds: Math.round(result.delayMs / 1000),
			}),
			{
				status: 202,
				headers: {
					...JSON_HEADERS,
					"access-control-allow-origin": "*",
				},
			},
		);
	},
} satisfies ExportedHandler<Env>;

function toIso(value?: number): string | undefined {
	if (!value) {
		return undefined;
	}

	return new Date(value).toISOString();
}

function truncateError(error: unknown): string {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: JSON.stringify(error);

	return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

declare global {
	interface Env {
		WEBHOOK_DELAY_DURABLE_OBJECT: DurableObjectNamespace<WebhookDelayDurableObject>;
		BUILD_WEBHOOK_URL: string;
		BUILD_DELAY_SECONDS?: string;
		BUILD_TRIGGER_METHOD?: string;
		WEBHOOK_SECRET?: string;
	}
}
