import {
	DurableObject,
	DurableObjectNamespace,
	type ExecutionContext,
} from "cloudflare:workers";

const STATE_KEY = "scheduler-state";
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
	webhookUrl?: string;
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
	webhookUrl?: string;
};

export class WebhookDelayDurableObject extends DurableObject<Env> {
	async queueBuild(
		webhookUrl: string,
		delaySeconds: number,
	): Promise<QueueResponse> {
		const state = await this.getState();
		const now = Date.now();
		const delayMs = Math.round(delaySeconds * 1000);
		const scheduledFor = now + delayMs;

		state.lastWebhookAt = now;
		state.scheduledFor = scheduledFor;
		state.retryCount = 0;
		state.delayMs = delayMs;
		state.webhookUrl = webhookUrl;

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
			webhookUrl: state.webhookUrl,
		};
	}

	async alarm(): Promise<void> {
		const state = await this.getState();
		const scheduledFor = state.scheduledFor;

		if (!scheduledFor) {
			return;
		}

		const webhookUrl = state.webhookUrl;

		if (!webhookUrl) {
			console.error("No webhook URL stored in state.");
			state.lastBuildAt = Date.now();
			state.lastBuildStatus = "error";
			state.lastError = "No webhook URL available for execution.";
			state.retryCount = (state.retryCount ?? 0) + 1;
			await this.setState(state);
			return;
		}

		try {
			const response = await fetch(webhookUrl, {
				method: "POST",
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

		const webhookUrlHeader = request.headers.get("x-webhook-url");
		if (!webhookUrlHeader) {
			return new Response("Missing x-webhook-url header", { status: 400 });
		}

		let parsedWebhookUrl: URL;
		try {
			parsedWebhookUrl = new URL(webhookUrlHeader);
		} catch {
			return new Response("Invalid x-webhook-url header", { status: 400 });
		}

		if (!["http:", "https:"].includes(parsedWebhookUrl.protocol)) {
			return new Response("Unsupported webhook protocol", { status: 400 });
		}

		const delaySecondsHeader = request.headers.get("x-delay-seconds");
		if (!delaySecondsHeader) {
			return new Response("Missing x-delay-seconds header", { status: 400 });
		}

		const delaySeconds = Number.parseInt(delaySecondsHeader, 10);
		if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
			return new Response("Invalid x-delay-seconds header", { status: 400 });
		}

		const stub = env.WEBHOOK_DELAY_DURABLE_OBJECT.getByName("scheduler");
		const result = await stub.queueBuild(parsedWebhookUrl.toString(), delaySeconds);

		return new Response(
			JSON.stringify({
				ok: true,
				scheduledFor: new Date(result.scheduledFor).toISOString(),
				delaySeconds: Math.round(result.delayMs / 1000),
				webhookUrl: parsedWebhookUrl.toString(),
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
		WEBHOOK_SECRET?: string;
	}
}
