import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createNapcatChannelPlugin } from "../../channels/napcat.js";
import { createTelegramChannelPlugin } from "../../channels/telegram.js";
import { NEKOCLAW_CONTAINER_WORKSPACE_DIR } from "../../config.js";
import { ensureAgentContainer, removeAgentContainer } from "../../runtime/docker.js";
import { JobQueueService } from "../../runtime/job-queue.js";
import { MessageRouterService } from "../../runtime/message-router.js";
import { OutboundDispatchService } from "../../runtime/outbound-dispatch.js";
import { CommandRouterService } from "../../runtime/command-router.js";
import { WorkerRunnerService } from "../../runtime/worker-runner.js";
import { getRuntimeKey } from "../../runtime/runtime-key.js";
import { JsonNekoclawStore } from "../../store/json-store.js";
import type {
	AgentSpec,
	AuditEntry,
	ChannelPlugin,
	ChannelType,
	PairRequest,
	QueueEvent,
	ReplyPayload,
	RunJob,
	SessionRecord,
	WorkerResult,
} from "../../types.js";
import { FakeNapcatClient, FakeTelegramBot, type HarnessTranscriptEntry, createTelegramMessage } from "./fake-transports.js";

export type HarnessChannel = "telegram" | "napcat" | "both";

export interface InternalChatHarnessRunOptions {
	agentRef: string;
	channel?: HarnessChannel;
	scenario?: string | string[];
	keepSandbox?: boolean;
	verbose?: boolean;
	timeoutMs?: number;
	executeJob?: (job: RunJob, context: CurrentEnvHarnessContext) => Promise<WorkerResult>;
}

export interface InternalChatHarnessEvidence {
	transcript: HarnessTranscriptEntry[];
	pairs: PairRequest[];
	queueTail: QueueEvent[];
	auditTail: AuditEntry[];
	sessionLogTail: unknown[];
	lastError?: string;
	sandboxAgentSlug: string;
}

export interface InternalChatHarnessScenarioResult {
	name: string;
	channel: Exclude<HarnessChannel, "both">;
	status: "passed" | "failed" | "skipped";
	durationMs: number;
	error?: string;
	outboundPreview?: string;
	evidence: InternalChatHarnessEvidence;
}

export interface InternalChatHarnessReport {
	ok: boolean;
	agentRef: string;
	agentSlug: string;
	startedAt: string;
	finishedAt: string;
	results: InternalChatHarnessScenarioResult[];
}

interface HarnessDriver {
	readonly channel: Exclude<HarnessChannel, "both">;
	readonly plugin: ChannelPlugin;
	getTranscript(): HarnessTranscriptEntry[];
	clearTranscript(): void;
	sendMessage(input: {
		chatKind: "dm" | "group";
		chatId?: string;
		senderId: string;
		senderName: string;
		text: string;
		replyToMessageId?: string;
		mentionBot?: boolean;
		attachments?: Array<{
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		}>;
		attachment?: {
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		};
	}): Promise<{ chatId: string; messageId: string }>;
	botUserId(): string;
	botUsername(): string | undefined;
}

export interface CurrentEnvHarnessContext {
	store: JsonNekoclawStore;
	agent: AgentSpec;
	outboundDispatch: OutboundDispatchService;
	jobQueue: JobQueueService;
	plugins: Map<string, ChannelPlugin>;
	drivers: Map<Exclude<HarnessChannel, "both">, HarnessDriver>;
	timeoutMs: number;
	workspaceRoot: string;
	createWorkspaceFixture(input: { relativePath: string; bytes: Uint8Array }): {
		relativePath: string;
		hostPath: string;
		containerPath: string;
	};
	_restoreFetchRegistry?: () => void;
}

interface ScenarioContext extends CurrentEnvHarnessContext {
	driver: HarnessDriver;
	channel: Exclude<HarnessChannel, "both">;
	dmChatId: string;
	groupChatId: string;
	dmUserId: string;
	groupUserId: string;
	adminUserId: string;
}

interface ScenarioDefinition {
	name: string;
	channel: Exclude<HarnessChannel, "both">;
	run(context: ScenarioContext): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const GROUP_TITLE = "Harness Group";
const RED_PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lcezWQAAAABJRU5ErkJggg==",
	"base64",
);
const BLUE_PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==",
	"base64",
);
const NATURAL_SCENE_PNG_BYTES = Buffer.from(
	"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",
	"base64",
);
const MIXED_SCENE_PNG_BYTES = Buffer.from(
	"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",
	"base64",
);
const MIXED_SCENE_OCR_PNG_BYTES = Buffer.from(
	"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unWM/9qZN29e7969i/6yrVq1qqysbN26dbt27dq1a7fddtvtsMMOO++886677tqlS5du3bp17959n332qaysLNY7Ll68uGvXrlFGvvHGG927dy/W+95xxx1Dhw7N96hx48ZddNFFxZoDkDViFMpGfX19Lperq6tbt25ds4O//e1vDxo06KSTTvr6178e35Rqa2unTp0acfDSpUtnzZrV8igvvfr6+vr6+vXr19fU1ORyuSVLlmw+pn379ocddtixxx578skn77zzziWfYxFMmzZt2LBh+R512223xVqiy5Yt23XXXeN7/SiWL1++0047hZ0DpJhtejIkU3v0v/vd7y6++OIuXbqMHDnyiy++iOldZs2a9fHHH0cff/fdd8c0k+BWr1791FNPNZ7zCy+88L333gs9o/zMnj37zDPPbGhoyOuoG2+88dJLL41pSkBGiFFIszVr1owePfob3/jGnDlz4nj9e++9N6/xTz31VNlVWr5qamrGjx/fvXv3u+66K/RconrhhRd+9KMf1dbW5nXUNddcM2LEiJimBGSHGCUrMrUsuomPP/74uOOOGzNmTHFfdsmSJU8++WReh9TX1+fbr2Vq9erVF1xwwY9+9KP169eHnkszFi5c2Ldv38YrEKIbMWLEz3/+85imBGSKGIVMqK+vHzFixH/8x38U8TUnT55cV1eX71GTJk3KdwWufD344IP9+/dfu3Zt6Ils1VtvvdWnT5/PP/88r6MuvfTSG2+8MaYpAVkjRiFbRo4c+etf/7rlr/PMM8+8++67hR2b4tuYtujuu+++//77Q89iU59++unRRx+d7yW855577tixY2OaEpBNYpT0syy6iSFDhqxYsaKFLzJx4sSCj33yySdTfxvTJoYMGbJy5crQs/i71atXH3PMMX/+85/zOuq0006bMGFCRUVFTLMCskmMQuZ8/PHHw4cPb8krrFix4pFHHin48OzcxrTBihUrinWBRMutXbv2hBNO+P3vf5/XUQMHDpw8ebISBYpOjJJylkW3aOLEiW+99VbBh0+bNm3NmjUtmcCkSZMKuPmprN1xxx2fffZZ6Fnk6urqBg0aNH/+/LyOGjBgwNSpU1u18p8MoPhS+G8W8UH5qqysbNiS+vr62traNWvWfP7558uXL1+8ePHrr78+b968SZMmDR48OOL3Rm6soaHhnnvuKXieLdmjbxT8NqaampotnuqNz3njaV+3bl1NTc0XX3zx6aeffvDBB3/605/+53/+5/LLL99jjz3yesc1a9bMnDkzph8nuvPPP/+hhx7K65DjjjtuxowZsX6Pa5JdeOGFvn4JYpXCGIUNUvMnk8avpG/Tpk2HDh122mmnLl269OjRo1evXmeeeeb48ePfeeedWbNm7bvvvnm95pQpU6J8rejmFixY8Prrrxdw4CYSfhtTRUVF42mvqqpq27Zt+/btd9xxxz322GO//fY77rjjbrnllsWLF48fP3677baL/prTp0+Pb8JRDB8+PN8/SPTp0+fBBx+sqqqKaUoJd8YZZ4wbl5J/jUBiiVEoexUVFccee+zChQtPO+206EctX778xRdfLODtinW559y5c99///2ivFQQlZWVgwcPfvHFF6Mvm/32t79t4eUNLXHTTTfdcssteR3Sq1evRx55ZJtttolpSgnXp0+fe+65x2WyEDcxSmqlZlk0orZt206ZMuXUU0+Nfki+t7DkcrmvvvpqxowZ+R61Rem4jalHjx5Tp06NOLi2tva1116Lczpbde+9915xxRV5HXLEEUc89thjbdu2jWlKEe2yyy5NX1BRgNra2iOPPLLp991vv/1mzpyZ2YsToJTEKOmUtRJtVFFRcdddd+29994RxxcQow8++GC+39bThHTcxvTv//7vPXv2jDi4KFc45Ouhhx46//zz8zrk0EMPnTNnzrbbbhvTlMK65pprnn/++SYGdOzY8bHHHuvQoUPJpgRZJkYhVaqrq6+88sqIgxcuXJjv60e84vD000+PMmzJkiVz5szJdw4JdNJJJ0Uc+cknn8Q6k83NmzfvlFNOqa+vj37IwQcfPHfu3Pbt28c3q4DmzZvX7HeZTpkypVu3bqWZDyBGSaFsLotuMHDgwIhbq/l+D+T//u//RrnMdPvtt7/zzjt33333KK85YcKEvOaQTAcffHDEkSV+9P3vfve7fv365XWn2oEHHvjkk0/mdWNWGVm2bNmgQYOaTvNhw4Ydf/zxJZsSkM4YzXiLZJxPv02bNoccckiUkTU1NXllSsRl0ZNOOqm6uvrHP/5xlMFz58794IMPos8hmXbeeedII2tqamKdycb+/Oc/H3PMMatXr45+SPfu3Z9++ukddtghvlkFVF9ff8oppzT9Z7D9999/zJgxJZsSkEtrjELG/dM/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KK680PWbw4MGlf9AssDVZiVE1U6Z8cMVyyCGHvPrqqz169Ig4PuKyaKdOnY4++uiIr9m5c+ejjjoqyshyuY3pyCOPXLRo0YoVK+bMmXPJJZfsueeeoWf0D6644oobbrhh7Nix0fej77zzzpdffjnWWcWt2WXRioqKc889tzSTAaLISoxSjpRoUbRt2/bGG2986aWXdt9994iH1NbWTp06NcrIU089Na9VwJTdxvT888+ffPLJf/zjH0NPZAt+8pOfjB49OpfLHXLIIdFXr+vr688555y1a9fGObUYLV++/IEHHmh6zPe+970oX/cAlEyGYlTZlBefV8tVVVWdc845ixYtGjFiRF7JOHv27GXLlkUZme+Fd/369Yt4xeqcOXOWLFmS14vnpaampqGhoaGhYd26datXr16yZMnrr7/+0EMPXXnllQcccED011m4cOG3v/3tAr4XPlaXXXbZzTffvOH/jhkzZrvttot47JtvvnnDDTfEM6/Y3X333c2WdMRrl4GSyVCMQkZUVlYeeuihN99884cffnjPPfcUsAgU8f6hAw88MPq+f6N27dpFfLh6yW5jqqqqqq6u3m233Xr06NG/f/9Ro0a99tpr8+bN++d//ueIr7B27dqLL7540KBBCVlQHDZs2K233rrxX+nUqdPVV18d/RXGjBnT7Fe6J9PkyZObHtC+ffv+/fuXZjJAREm5yr40BvYaN2P+kNCzoHmWRbemVatWlZWVbdq0adOmzbbbbtuhQ4eOHTvuuOOOnTp12n333ffcc8999tmnR48eHTp0KPgtPvroo4jXa7722muxPhxn4sSJP/vZzyLe81RcvXr1WrBgwZlnnjlz5syIh9x///0ffPDB7Nmzo69BxuHiiy/+xS9+scW/fs899yxatCjKi6xfv/6cc855+eWXy+ursF5++eV33nmn6TEnnnhidXV1aeYDRJStGIWEq6ysrK2tDTuHKVOm1NXVhZ1Do/fff3/u3LnHHHNMkHffdtttZ8yY0aZNm1/96lcRD3nxxRf79Onz5JNPtuQPAy0xZMiQ22+/fYt/q6qq6vbbb+/Tp0/El/r9739/++23X3rppcWbXeymTZvW7JiUfesppEPmtuktuSWfzyighoaGiI/EL40JEyYEfPdWrVpNnDjxiCOOiH7IK6+80q9fv/Xr18c3q6254IILmr509fvf/37fvn2jv+BVV1317rvvtnheJVJXV/fggw82PaZ9+/Y9e/YsyXSAPGQuRoEmPPfcc81udJbSnDlzmv0qnVhVVVU98MADu+yyS/RD5s+fP3To0PimtEXnn3/+nXfe2eywX/ziF23atIn4ml999dV5553XsnmVzvPPP//JJ580Peboo4+O/uMDJZPFGLXwlmQ+nbAiPl60ZJLwbUy77LLLr371q7yujh0/fvz06dPjm9Imzj333PHjx0eZYbdu3fLaeZ8/f36iVsqb8MgjjzQ75thjjy3BTIB8ZTFGc4onqXwuYa1cufLhhx+OPYtNJeHbmP7t3/4t36snBw8eXJo15rPOOmvChAnRW/nKK6+M/sTZXC532WWXRXzOV1iPPvpo0wNatWr1gx/8oCRzAfKT0RgFNjdt2rQ1a9aEnsWm3nvvvblz54aeRe6GG27Yf//9o49fvXr1qaeeWoJbwS655JK8Vm2rq6tvuumm6ONXrlw5ZEjSH0LyxhtvfPjhh02P+dd//devf/3rpZkPkJfsxqhFuKTxiQQXfEN8a5LwbUxt2rSZOnVqVVVV9EN++9vfbvzk+eQYNGjQd7/73ejjH3rooQQumW/sqaeeanbMkUceWYKZAAXIbozm1E+S+CyCe/XVV1977bXQs9iy4LcxNTrwwAOvuuqqvA659tpr33zzzZjm0xJ33HFHXg9wHTJkyMqVK2ObTktFidHDDz+8BDMBCpDpGAU2SOyyaC6Xq62tTchtNCNGjDjooIOij1+7du3ZZ58d/JrXzX3rW98655xzoo9funTp5ZdfHt98WqK2tvY3v/lN02MqKiq+853vlGY+QL6yHqMW5JLApxBcTU3N/fffH3oWTbn33nuTkHStW7eeMmVKXpv1r7zyyvjx4+ObUsFuuOGGHXbYIfr4iRMnPvPMM/HNp2ALFy786quvmh6z33777bjjjqWZD5CvrMdoTgmF5vwnwa9//etVq1ZFGTl16tSG4lm7du3Xvva1KO/73nvvPfnkky37KYtj//33/9nPfpbXISNHjly6dGlM8ynYTjvtdO211+Z1yHnnndds9pXeSy+91OwYe/SQZGI0l9ND4TjzCRHx8aLV1dX9+vUr4vtus802gwYNijg4CbcxNRoxYsQBBxwQffznn38+bNiw2KZTuAsvvLB79+7Rx7/zzjtXX311fPMpzCuvvNLsmLwurgBKTIxC1r399tsvvPBClJH9+vVr3759cd/97LPPjjhy9uzZSbiNKZfLVVVVTZo0qXXr1tEPmTlzZkJWdjdWWVm5te+y35pf/vKXCxYsiGk+hVm4cGGzY3r06FGCmQCFEaP/zxJd6TnnCRH9W5d+/OMfF/3de/ToEXHVKjm3MeVyuYMOOmj48OF5HXLRRRcl8DGuRx111IABA6KPr6urO/vss9evXx/flPLy5ZdfNvvlAhUVFXktAAMlJkb/ThuVkrOdELW1tffdd1+UkbvuumuvXr3imMNZZ50VcWRCbmNqdPXVV++3337Rx7/zzjujR4+Obz4Fu+2229q1axd9/B//+Me8HpsfqzfeeKPZfyT22muv6urq0swHKIAY/QcKqTSc5+SYM2dOxC97HDhwYGVlZRxzGDRoUNu2baOMfO+996I8UbI02rRpM3ny5LzOyU033fTWW2/FN6XCdOnSJd9V3lGjRv3lL3+JaT55ifIYV3v0kHBidFM6KW7OcKJEf7xoHHv0jTp27HjCCSdEHJyc25hyudwhhxyS151Ja9euvfDCC2ObTuF++tOfdunSJfr4tWvXnnPOOQ0NDfFNKaJm9+hzudxee+1VgpkABROjW6CW4uPcJsrSpUsff/zxKCO7d+9+4IEHxjeT6LcxzZo1K1GPSbr++uu/8Y1vRB8/b968GTNmxDefwrRr1+7WW2/N65CXXnrpzjvvjGk+0b399tvNjtljjz1KMBOgYGJ0yzRTHJzVpJkyZUpdXV2UkfEtizbq1atXxJW5RN3GlMvl2rVrN2nSpIqKiuiHXHrppRGf6lpKJ5544ve+9728DhkxYsT7778f03wiWrx4cbNjOnfuHP9EgMKJ0a1STsXlfCZNQ0NDxKpr1arVKaecEutkKioqzjjjjIiDE3UbUy6X++53vztkyJDo45ctW5bvY/NL44477sjrEtjVq1cPHjw4vvlEEWWZXIxCwonRpuinYnEmE+j555+PssWZy+V69uxZgo3OM888M+L64uLFi59++um455OX0aNHd+3aNfr4//qv/3r11Vfjm09hunfvfsEFF+R1yBNPPDF9+vSY5hPFxx9/3OyY3XbbrQQzAQomRpuholrOOUymsI8X3VyXLl2OOuqoiIMnTJgQ62TyVV1dHf185nK5+vr6wYMHJ2p9t9F1112300475XXIsGHDli9fHtN8mrZq1aq1a9c2O6xDhw4lmAxQMDHaPC3VEs5eMq1cufLhhx+OMrJdu3Z5PRS9JaI/cHTWrFkRn0hVMkcdddR5550XffyCBQvuuuuu+OZTmB122GHUqFF5HfLJJ58MHTo0pvk0beXKlVGG5fUUVaD0xGgkiqowzltiTZ8+vaamJsrIE044oWQLS/379+/YsWOUkUm7janRLbfcktfliSNHjoyyy1xi55577re+9a28DpkxY8acOXNimk8TVq9e3eyYVq1abbPNNiWYDFAwMRrVwF7jpFV0TlfCRX+86KmnnhrrTDbWtm3b6HdK3XvvvUl4zuXGtttuu7weg7pq1apLL700vvkUplWrVmPHjs33qMGDB3/xxRdxzKcJX375ZbNjLItC8lWM/kOYa33K14z5edw2m00ZzND5wwdu8leSdocNUBS9e/fe5K/0ujlxD46F8mJlNG8ZLK28OD8AQHStQ0+gLDX2liXSTchQACBfVkYLp7025mwAAAWwMtoilkhzMhQAaAEro0WQ5RrL8s8OALScldHiyOASqQwFAFpOjBZTRpJUhgIAxSJGiy/FSSpDAYDiEqNxSVmSylAAIA5iNF4pSFIZCgDER4yWQpkmqQwFAOImRktnQ9slvEo1KABQMmI0gGRWqQYFAEpPjIa0of9W/+ybs77Xu/QT6Pvs0+1HLSr9+wIANBKjSdH32ac3/O9Yw3TjNwIACEuMJtEWe7GAQtWdAEDCidGyoSwBgPRpFXoCAABklxgFACAYMQoAQDBiFACAYMQoAADBiFEAAIIRowAABCNGAYCk0/8BltGw3C8/CUUAAAAASUVORK5CYII=",
	"base64",
);
const MIXED_SCENE_FIXTURE_BYTES = readFileSync(new URL("./fixtures/mixed-scene-ocr-v2.png", import.meta.url));
const FILE_SECRET = "HARNESS_FILE_SECRET_731";
const FILE_SECRET_EXTRA = "HARNESS_FILE_SECRET_992";
const FILE_SECRET_BYTES = Buffer.from(`${FILE_SECRET}\n`, "utf-8");
const FILE_SECRET_EXTRA_BYTES = Buffer.from(`${FILE_SECRET_EXTRA}\n`, "utf-8");

function nowIso(): string {
	return new Date().toISOString();
}

function assertCondition(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickScenarioNames(option: string | string[] | undefined, definitions: ScenarioDefinition[]): Set<string> | undefined {
	if (!option) {
		return undefined;
	}
	const names = Array.isArray(option) ? option : option.split(",").map((value) => value.trim()).filter(Boolean);
	return new Set(names);
}

function tail<T>(values: T[], count = 20): T[] {
	return values.slice(Math.max(0, values.length - count));
}

function installFetchRegistry(): {
	register(url: string, bytes: Uint8Array): void;
	restore(): void;
} {
	const binaries = new Map<string, Uint8Array>();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: typeof input === "object" && input !== null && "url" in input
						? String((input as { url: unknown }).url)
						: String(input);
		const bytes = binaries.get(url);
		if (bytes) {
			const view = bytes.slice();
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
			} as Response;
		}
		if (originalFetch) {
			return originalFetch(input as never, init);
		}
		throw new Error(`No harness media registered for ${url}`);
	}) as typeof fetch;
	return {
		register(url, bytes) {
			binaries.set(url, bytes);
		},
		restore() {
			if (originalFetch) {
				globalThis.fetch = originalFetch;
				return;
			}
			delete (globalThis as { fetch?: typeof fetch }).fetch;
		},
	};
}

function readSessionLogTail(store: JsonNekoclawStore, agent: AgentSpec, count = 20): unknown[] {
	const sessions = store.listSessions(agent.agentId);
	if (sessions.length === 0) {
		return [];
	}
	const latest = sessions[sessions.length - 1];
	const path = store.getSessionLogPath(agent.slug, latest.sessionRecordId);
	if (!existsSync(path)) {
		return [];
	}
	return tail(
		readFileSync(path, "utf-8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return line;
				}
			}),
		count,
	);
}

async function waitForQueueIdle(context: CurrentEnvHarnessContext): Promise<void> {
	const deadline = Date.now() + context.timeoutMs;
	while (Date.now() < deadline) {
		const status = context.jobQueue.getStatus(context.agent.agentId);
		if (!status.processing && status.queued === 0) {
			await sleep(25);
			const next = context.jobQueue.getStatus(context.agent.agentId);
			if (!next.processing && next.queued === 0) {
				return;
			}
		}
		await sleep(50);
	}
	throw new Error(`Timed out waiting for queue idle after ${context.timeoutMs}ms`);
}

function getPendingPair(store: JsonNekoclawStore, agentId: string, channel: ChannelType, chatId: string): PairRequest | undefined {
	return store
		.listPairRequests(agentId)
		.find((pair) => pair.channelType === channel && pair.externalConversationId === chatId && pair.status === "pending");
}

async function acceptPendingPair(context: ScenarioContext, chatId: string): Promise<SessionRecord> {
	const pair = getPendingPair(context.store, context.agent.agentId, context.channel, chatId);
	assertCondition(pair, `Expected a pending ${context.channel} pair for chat ${chatId}`);
	const accepted = context.store.acceptPair(pair.code);
	await context.outboundDispatch.sendPairAcceptedMessage(accepted.pair);
	return accepted.session;
}

function latestOutbound(driver: HarnessDriver, chatId: string): HarnessTranscriptEntry | undefined {
	return [...driver.getTranscript()].reverse().find((entry) => entry.kind === "outbound" && entry.chatId === chatId);
}

function countOutbound(driver: HarnessDriver, chatId: string): number {
	return driver.getTranscript().filter((entry) => entry.kind === "outbound" && entry.chatId === chatId).length;
}

function latestSession(store: JsonNekoclawStore, agentId: string, chatId: string): SessionRecord | undefined {
	return [...store.listSessions(agentId)].reverse().find((session) => session.externalConversationId === chatId);
}

async function sendAndWait(
	context: ScenarioContext,
	input: Parameters<HarnessDriver["sendMessage"]>[0],
): Promise<{ chatId: string; messageId: string }> {
	const sent = await context.driver.sendMessage(input);
	await waitForQueueIdle(context);
	return sent;
}

async function expectOutboundContains(
	context: ScenarioContext,
	chatId: string,
	matcher: string | RegExp,
): Promise<HarnessTranscriptEntry> {
	await waitForQueueIdle(context);
	const outbound = latestOutbound(context.driver, chatId);
	assertCondition(outbound, `Expected outbound message for chat ${chatId}`);
	const text = outbound.text ?? "";
	if (typeof matcher === "string") {
		assertCondition(text.includes(matcher), `Expected outbound to contain "${matcher}", got "${text}"`);
	} else {
		assertCondition(matcher.test(text), `Expected outbound to match ${matcher}, got "${text}"`);
	}
	return outbound;
}

async function expectAnyOutboundContains(
	context: ScenarioContext,
	chatId: string,
	matcher: string | RegExp,
): Promise<HarnessTranscriptEntry> {
	await waitForQueueIdle(context);
	const outbound = context.driver
		.getTranscript()
		.filter((entry) => entry.kind === "outbound" && entry.chatId === chatId)
		.find((entry) => {
			const text = entry.text ?? "";
			return typeof matcher === "string" ? text.includes(matcher) : matcher.test(text);
		});
	assertCondition(outbound, `Expected some outbound for chat ${chatId} to match ${String(matcher)}`);
	return outbound;
}

async function expectLatestOutboundContainsAll(
	context: ScenarioContext,
	chatId: string,
	matchers: Array<string | RegExp>,
): Promise<HarnessTranscriptEntry> {
	await waitForQueueIdle(context);
	const outbound = latestOutbound(context.driver, chatId);
	assertCondition(outbound, `Expected outbound message for chat ${chatId}`);
	const text = outbound.text ?? "";
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			assertCondition(text.includes(matcher), `Expected outbound to contain "${matcher}", got "${text}"`);
			continue;
		}
		assertCondition(matcher.test(text), `Expected outbound to match ${matcher}, got "${text}"`);
	}
	return outbound;
}

async function expectNoOutboundDelta(context: ScenarioContext, chatId: string, previousCount: number): Promise<void> {
	await waitForQueueIdle(context);
	const currentCount = countOutbound(context.driver, chatId);
	assertCondition(currentCount === previousCount, `Expected no new outbound for chat ${chatId}, got ${currentCount - previousCount}`);
}

function knownModelRef(store: JsonNekoclawStore, agent: AgentSpec): string {
	assertCondition(agent.provider && agent.modelId, `Agent ${agent.slug} has no configured model`);
	return `${agent.provider}/${agent.modelId}`;
}

function listSessionAttachmentNames(context: ScenarioContext, sessionRecordId: string): string[] {
	const dir = context.store.getSessionAttachmentsDir(context.agent.slug, sessionRecordId);
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir);
}

function presetGroupTrigger(context: ScenarioContext, mode: "all" | "mention"): void {
	context.store.setChannelGroupTrigger(context.agent.agentId, context.channel, mode);
	(context.driver.plugin as { groupTrigger?: "all" | "mention" }).groupTrigger = mode;
}

async function scenarioDmPairPrompt(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "hello there",
	});
	await expectOutboundContains(context, context.dmUserId, "This chat is not paired yet.");
}

async function scenarioDmPairAcceptAndChat(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "please pair me",
	});
	await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Reply with exactly: HARNESS_OK",
	});
	const outbound = latestOutbound(context.driver, context.dmUserId);
	assertCondition(outbound?.text?.trim(), "Expected a non-empty outbound after DM chat");
}

async function scenarioDmContextContinuity(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Remember this codeword for later: NEKO-ALPHA-742. Reply with exactly: remembered NEKO-ALPHA-742",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "What codeword did I ask you to remember? Reply with the codeword only.",
	});
	await expectOutboundContains(context, context.dmUserId, "NEKO-ALPHA-742");
}

async function scenarioGroupMentionIgnored(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	const before = countOutbound(context.driver, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "plain group message without mention",
	});
	await expectNoOutboundDelta(context, context.groupChatId, before);
}

async function scenarioGroupMentionChat(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "say HARNESS_GROUP_OK",
		mentionBot: true,
	});
	const outbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(outbound?.text?.trim(), "Expected outbound after mention-addressed group message");
}

async function scenarioGroupReplyChat(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "prime the thread",
		mentionBot: true,
	});
	const firstOutbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(firstOutbound?.messageId, "Expected a first outbound group reply");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "reply path should work",
		replyToMessageId: firstOutbound.messageId,
	});
	const outbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(outbound?.text?.trim(), "Expected outbound after reply-addressed group message");
}

async function scenarioGroupPairCommand(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "all");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
	});
	await expectOutboundContains(context, context.groupChatId, "This chat is not paired yet.");
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "Say paired",
		mentionBot: true,
	});
	const outbound = latestOutbound(context.driver, context.groupChatId);
	assertCondition(outbound?.text?.trim(), "Expected outbound after pairing a group chat");
}

async function scenarioAdminStatus(context: ScenarioContext): Promise<void> {
	presetGroupTrigger(context, "all");
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/status",
		mentionBot: context.channel === "telegram",
	});
	await expectOutboundContains(context, context.groupChatId, /Effective model:/);
}

async function scenarioAdminTriggerToggle(context: ScenarioContext): Promise<void> {
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	presetGroupTrigger(context, "mention");
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "/pair",
		mentionBot: true,
	});
	await acceptPendingPair(context, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/trigger all",
		mentionBot: true,
	});
	await expectAnyOutboundContains(context, context.groupChatId, "updated to all");
	const before = countOutbound(context.driver, context.groupChatId);
	await sendAndWait(context, {
		chatKind: "group",
		chatId: context.groupChatId,
		senderId: context.groupUserId,
		senderName: "Group User",
		text: "this should now route without mention",
	});
	assertCondition(countOutbound(context.driver, context.groupChatId) > before, "Expected group trigger all to allow a plain message");
}

async function scenarioAdminReset(context: ScenarioContext): Promise<void> {
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.adminUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "Remember this codeword: RESET-ME-188",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/reset",
	});
	await expectOutboundContains(context, context.adminUserId, "Session reset.");
	const contextPath = context.store.getSessionContextPath(context.agent.slug, session.sessionRecordId);
	assertCondition(readFileSync(contextPath, "utf-8").trim() === "", "Expected /reset to clear the session context file");
	const latest = context.store.getSession(context.agent.agentId, session.sessionRecordId);
	assertCondition(!latest.modelOverride, "Expected /reset to clear the session model override");
}

async function scenarioAdminModelSessionOverride(context: ScenarioContext): Promise<void> {
	context.store.addAdmin(context.agent.agentId, {
		channelType: context.channel,
		externalUserId: context.adminUserId,
		displayName: "Harness Admin",
	});
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.adminUserId);
	const modelRef = knownModelRef(context.store, context.agent);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: `/model ${modelRef}`,
	});
	const updated = context.store.getSession(context.agent.agentId, session.sessionRecordId);
	assertCondition(updated.modelOverride, "Expected /model to set a session model override");
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.adminUserId,
		senderId: context.adminUserId,
		senderName: "Harness Admin",
		text: "/status",
	});
	await expectOutboundContains(context, context.adminUserId, "(session override)");
}

async function scenarioDmImageVision(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Look at this image and reply with exactly: RED",
		attachment: {
			kind: "image",
			name: "red-square.png",
			mimeType: "image/png",
			bytes: RED_PNG_BYTES,
		},
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).length > 0,
		"Expected the inbound image to be persisted into the session attachments directory",
	);
	await expectOutboundContains(context, context.dmUserId, /RED/i);
}

async function scenarioDmMultiImageVision(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "You received two images in one message. Reply with exactly: RED,BLUE",
		attachments: [
			{
				kind: "image",
				name: "red-square.png",
				mimeType: "image/png",
				bytes: RED_PNG_BYTES,
			},
			{
				kind: "image",
				name: "blue-square.png",
				mimeType: "image/png",
				bytes: BLUE_PNG_BYTES,
			},
		],
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).filter((name) => /\.(png|jpg|jpeg)$/i.test(name)).length >= 2,
		"Expected both inbound images to be persisted into the session attachments directory",
	);
	await expectLatestOutboundContainsAll(context, context.dmUserId, [/RED/i, /BLUE/i]);
}

async function scenarioDmNaturalImageDescription(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Describe the scene in one short English sentence. Mention TREE, HOUSE, and SUN only if they are actually visible.",
		attachment: {
			kind: "image",
			name: "natural-scene.png",
			mimeType: "image/png",
			bytes: NATURAL_SCENE_PNG_BYTES,
		},
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).length > 0,
		"Expected the natural image to be persisted into the session attachments directory",
	);
	await expectLatestOutboundContainsAll(context, context.dmUserId, [/tree/i, /house/i, /sun/i]);
}

async function scenarioDmFileAttachment(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Open the attached file and reply with the secret word only.",
		attachment: {
			kind: "file",
			name: "note.txt",
			mimeType: "text/plain",
			bytes: FILE_SECRET_BYTES,
		},
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).some((name) => name.endsWith(".txt")),
		"Expected the inbound file to be persisted into the session attachments directory",
	);
	await expectAnyOutboundContains(context, context.dmUserId, FILE_SECRET);
}

async function scenarioDmMultiFileAttachment(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "Open both attached files and reply with both secrets in order separated by a comma only.",
		attachments: [
			{
				kind: "file",
				name: "note-a.txt",
				mimeType: "text/plain",
				bytes: FILE_SECRET_BYTES,
			},
			{
				kind: "file",
				name: "note-b.txt",
				mimeType: "text/plain",
				bytes: FILE_SECRET_EXTRA_BYTES,
			},
		],
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).filter((name) => name.endsWith(".txt")).length >= 2,
		"Expected both inbound files to be persisted into the session attachments directory",
	);
	await expectLatestOutboundContainsAll(context, context.dmUserId, [FILE_SECRET, FILE_SECRET_EXTRA]);
}

async function scenarioDmImageTextMixed(context: ScenarioContext): Promise<void> {
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "pair me",
	});
	const session = await acceptPendingPair(context, context.dmUserId);
	await sendAndWait(context, {
		chatKind: "dm",
		chatId: context.dmUserId,
		senderId: context.dmUserId,
		senderName: "Harness DM",
		text: "This is a synthetic benchmark image. Read the exact uppercase text printed on the red octagonal road sign. Reply with the sign text only, preserving spaces, and do not add any extra words.",
		attachment: {
			kind: "image",
			name: "mixed-scene.png",
			mimeType: "image/png",
			bytes: MIXED_SCENE_FIXTURE_BYTES,
		},
	});
	assertCondition(
		listSessionAttachmentNames(context, session.sessionRecordId).length > 0,
		"Expected the mixed image to be persisted into the session attachments directory",
	);
	await expectLatestOutboundContainsAll(context, context.dmUserId, [/stop/i]);
}

const SCENARIOS: ScenarioDefinition[] = [
	{ name: "dm_pair_prompt", channel: "telegram", run: scenarioDmPairPrompt },
	{ name: "dm_pair_accept_and_chat", channel: "telegram", run: scenarioDmPairAcceptAndChat },
	{ name: "dm_context_continuity", channel: "telegram", run: scenarioDmContextContinuity },
	{ name: "dm_image_vision", channel: "telegram", run: scenarioDmImageVision },
	{ name: "dm_multi_image_vision", channel: "telegram", run: scenarioDmMultiImageVision },
	{ name: "dm_natural_image_description", channel: "telegram", run: scenarioDmNaturalImageDescription },
	{ name: "dm_file_attachment", channel: "telegram", run: scenarioDmFileAttachment },
	{ name: "dm_multi_file_attachment", channel: "telegram", run: scenarioDmMultiFileAttachment },
	{ name: "dm_image_text_mixed", channel: "telegram", run: scenarioDmImageTextMixed },
	{ name: "group_mention_ignored", channel: "telegram", run: scenarioGroupMentionIgnored },
	{ name: "group_mention_chat", channel: "telegram", run: scenarioGroupMentionChat },
	{ name: "group_reply_chat", channel: "telegram", run: scenarioGroupReplyChat },
	{ name: "group_pair_command", channel: "telegram", run: scenarioGroupPairCommand },
	{ name: "admin_status", channel: "telegram", run: scenarioAdminStatus },
	{ name: "admin_trigger_toggle", channel: "telegram", run: scenarioAdminTriggerToggle },
	{ name: "admin_reset", channel: "telegram", run: scenarioAdminReset },
	{ name: "admin_model_session_override", channel: "telegram", run: scenarioAdminModelSessionOverride },
	{ name: "dm_pair_prompt", channel: "napcat", run: scenarioDmPairPrompt },
	{ name: "dm_pair_accept_and_chat", channel: "napcat", run: scenarioDmPairAcceptAndChat },
	{ name: "dm_context_continuity", channel: "napcat", run: scenarioDmContextContinuity },
	{ name: "dm_image_vision", channel: "napcat", run: scenarioDmImageVision },
	{ name: "dm_multi_image_vision", channel: "napcat", run: scenarioDmMultiImageVision },
	{ name: "dm_natural_image_description", channel: "napcat", run: scenarioDmNaturalImageDescription },
	{ name: "dm_file_attachment", channel: "napcat", run: scenarioDmFileAttachment },
	{ name: "dm_multi_file_attachment", channel: "napcat", run: scenarioDmMultiFileAttachment },
	{ name: "dm_image_text_mixed", channel: "napcat", run: scenarioDmImageTextMixed },
	{ name: "group_mention_ignored", channel: "napcat", run: scenarioGroupMentionIgnored },
	{ name: "group_mention_chat", channel: "napcat", run: scenarioGroupMentionChat },
	{ name: "group_reply_chat", channel: "napcat", run: scenarioGroupReplyChat },
	{ name: "group_pair_command", channel: "napcat", run: scenarioGroupPairCommand },
	{ name: "admin_status", channel: "napcat", run: scenarioAdminStatus },
	{ name: "admin_trigger_toggle", channel: "napcat", run: scenarioAdminTriggerToggle },
	{ name: "admin_reset", channel: "napcat", run: scenarioAdminReset },
	{ name: "admin_model_session_override", channel: "napcat", run: scenarioAdminModelSessionOverride },
];

class TelegramHarnessDriver implements HarnessDriver {
	readonly channel = "telegram" as const;
	readonly bot = new FakeTelegramBot({ id: 9001, username: "mock_bot" });
	readonly plugin: ChannelPlugin;

	private messageCounter = 1;

	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly agent: AgentSpec,
		private readonly registerRemoteBinary: (url: string, bytes: Uint8Array) => void,
	) {
		const channel = this.store.createChannel(agent.agentId, "telegram");
		this.store.setChannelToken(agent.agentId, "telegram", "harness-token");
		this.plugin = createTelegramChannelPlugin(channel, "harness-token", undefined, undefined, { bot: this.bot });
	}

	getTranscript(): HarnessTranscriptEntry[] {
		return this.bot.transcript;
	}

	clearTranscript(): void {
		this.bot.transcript.splice(0, this.bot.transcript.length);
	}

	async sendMessage(input: {
		chatKind: "dm" | "group";
		chatId?: string;
		senderId: string;
		senderName: string;
		text: string;
		replyToMessageId?: string;
		mentionBot?: boolean;
		attachments?: Array<{
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		}>;
		attachment?: {
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		};
	}): Promise<{ chatId: string; messageId: string }> {
		const chatId = input.chatId ?? (input.chatKind === "dm" ? input.senderId : "-100123");
		const authoredText =
			input.chatKind === "group" && input.mentionBot
				? `@${this.botUsername() ?? "mock_bot"} ${input.text}`
				: input.text;
		const attachments = input.attachments ?? (input.attachment ? [input.attachment] : []);
		const firstMessageId = String(this.messageCounter);
		const mediaGroupId = attachments.length > 1 ? `tg-media-group-${randomUUID()}` : undefined;
		if (attachments.length === 0) {
			const messageId = String(this.messageCounter++);
			await this.bot.emitInbound(
				createTelegramMessage({
					chatId: Number(chatId),
					chatType: input.chatKind === "dm" ? "private" : "supergroup",
					chatTitle: input.chatKind === "group" ? GROUP_TITLE : undefined,
					messageId: Number(messageId),
					replyToMessageId: input.replyToMessageId ? Number(input.replyToMessageId) : undefined,
					text: authoredText,
					from: {
						id: Number(input.senderId),
						first_name: input.senderName,
						username: input.senderName.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
					},
				}),
			);
			return { chatId, messageId };
		}
		for (const [index, attachment] of attachments.entries()) {
			const messageId = String(this.messageCounter++);
			const remoteId = `tg-${attachment.kind}-${randomUUID()}`;
			const remotePath = `${attachment.kind === "image" ? "photos" : "documents"}/${attachment.name ?? `${remoteId}.${attachment.kind === "image" ? "jpg" : "bin"}`}`;
			this.bot.registerFile(remoteId, { file_path: remotePath });
			this.registerRemoteBinary(`https://api.telegram.org/file/botharness-token/${remotePath}`, attachment.bytes);
			await this.bot.emitInbound(
				createTelegramMessage({
					chatId: Number(chatId),
					chatType: input.chatKind === "dm" ? "private" : "supergroup",
					chatTitle: input.chatKind === "group" ? GROUP_TITLE : undefined,
					messageId: Number(messageId),
					mediaGroupId,
					replyToMessageId: input.replyToMessageId ? Number(input.replyToMessageId) : undefined,
					caption: index === 0 ? authoredText : undefined,
					photo:
						attachment.kind === "image"
							? [{ file_id: remoteId, file_size: attachment.bytes.byteLength }]
							: undefined,
					document:
						attachment.kind === "file"
							? {
									file_id: remoteId,
									file_name: attachment.name,
									mime_type: attachment.mimeType,
									file_size: attachment.bytes.byteLength,
								}
							: undefined,
					from: {
						id: Number(input.senderId),
						first_name: input.senderName,
						username: input.senderName.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
					},
				}),
			);
		}
		if (attachments.length > 1) {
			await sleep(125);
		}
		return { chatId, messageId: firstMessageId };
	}

	botUserId(): string {
		return "9001";
	}

	botUsername(): string | undefined {
		return "mock_bot";
	}
}

class NapcatHarnessDriver implements HarnessDriver {
	readonly channel = "napcat" as const;
	readonly client = new FakeNapcatClient();
	readonly plugin: ChannelPlugin;

	private messageCounter = 1;
	private readonly selfId = "9002";

	constructor(
		private readonly store: JsonNekoclawStore,
		private readonly agent: AgentSpec,
		private readonly registerRemoteBinary: (url: string, bytes: Uint8Array) => void,
	) {
		const channel = this.store.createChannel(agent.agentId, "napcat");
		this.store.setChannelToken(agent.agentId, "napcat", "harness-token");
		this.store.setNapcatEndpoint(agent.agentId, {
			wsUrl: "ws://127.0.0.1:6700",
			selfId: this.selfId,
		});
		this.plugin = createNapcatChannelPlugin(
			channel,
			{
				wsUrl: "ws://127.0.0.1:6700",
				selfId: this.selfId,
			},
			undefined,
			undefined,
			{ client: this.client },
		);
	}

	getTranscript(): HarnessTranscriptEntry[] {
		return this.client.transcript;
	}

	clearTranscript(): void {
		this.client.transcript.splice(0, this.client.transcript.length);
	}

	async sendMessage(input: {
		chatKind: "dm" | "group";
		chatId?: string;
		senderId: string;
		senderName: string;
		text: string;
		replyToMessageId?: string;
		mentionBot?: boolean;
		attachments?: Array<{
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		}>;
		attachment?: {
			kind: "image" | "file";
			name?: string;
			mimeType?: string;
			bytes: Uint8Array;
		};
	}): Promise<{ chatId: string; messageId: string }> {
		const messageId = String(this.messageCounter++);
		const chatId = input.chatId ?? (input.chatKind === "dm" ? input.senderId : "-100123");
		const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
		const attachments = input.attachments ?? (input.attachment ? [input.attachment] : []);
		if (input.replyToMessageId) {
			segments.push({ type: "reply", data: { id: input.replyToMessageId } });
		}
		if (input.chatKind === "group" && input.mentionBot) {
			segments.push({ type: "at", data: { qq: this.selfId } });
			segments.push({ type: "text", data: { text: ` ${input.text}` } });
		} else {
			segments.push({ type: "text", data: { text: input.text } });
		}
		for (const attachment of attachments) {
			if (attachment.kind === "image") {
				const remoteUrl = `https://harness.invalid/napcat/${messageId}/${attachment.name ?? `image-${segments.length}.png`}`;
				this.registerRemoteBinary(remoteUrl, attachment.bytes);
				segments.push({
					type: "image",
					data: { url: remoteUrl, file: remoteUrl },
				});
				continue;
			}
			const remoteId = `napcat-file-${randomUUID()}`;
			this.client.registerFile(remoteId, {
				file: "",
				file_name: attachment.name ?? "attachment.bin",
				file_size: attachment.bytes.byteLength,
				base64: Buffer.from(attachment.bytes).toString("base64"),
			});
			segments.push({
				type: "file",
				data: {
					file: remoteId,
					name: attachment.name ?? "attachment.bin",
				},
			});
		}
		await this.client.emitInbound(
			input.chatKind === "dm" ? "message.private.friend" : "message.group.normal",
			{
				post_type: "message",
				message_type: input.chatKind === "dm" ? "private" : "group",
				sub_type: input.chatKind === "dm" ? "friend" : "normal",
				time: Math.floor(Date.now() / 1_000),
				self_id: Number(this.selfId),
				user_id: Number(input.senderId),
				group_id: input.chatKind === "group" ? Number(chatId) : undefined,
				message_id: Number(messageId),
				raw_message: input.chatKind === "group" && input.mentionBot ? `@bot ${input.text}` : input.text,
				message: segments,
				sender:
					input.chatKind === "group"
						? {
								user_id: Number(input.senderId),
								nickname: input.senderName,
								card: input.senderName,
								sex: "unknown",
								age: 0,
								area: "",
								level: "",
								role: "member",
								title: "",
							}
						: {
								user_id: Number(input.senderId),
								nickname: input.senderName,
							},
				anonymous: null,
			} as never,
		);
		return { chatId, messageId };
	}

	botUserId(): string {
		return this.selfId;
	}

	botUsername(): string | undefined {
		return undefined;
	}
}

function cloneAgentWorkspace(store: JsonNekoclawStore, source: AgentSpec, target: AgentSpec): void {
	const sourceRoot = store.getWorkspaceRoot(source.slug);
	const targetRoot = store.getWorkspaceRoot(target.slug);
	const files = ["SOUL.md", "AGENTS.md", "MEMORY.md"];
	for (const file of files) {
		const from = join(sourceRoot, file);
		const to = join(targetRoot, file);
		if (existsSync(from)) {
			cpSync(from, to, { force: true });
		}
	}
	const sourceSkills = join(sourceRoot, "skills");
	const targetSkills = join(targetRoot, "skills");
	rmSync(targetSkills, { recursive: true, force: true });
	mkdirSync(targetSkills, { recursive: true });
	if (existsSync(sourceSkills)) {
		cpSync(sourceSkills, targetSkills, { recursive: true, force: true });
	}
	const sourceRuntime = join(sourceRoot, ".nekoclaw-runtime");
	const targetRuntime = join(targetRoot, ".nekoclaw-runtime");
	rmSync(targetRuntime, { recursive: true, force: true });
	mkdirSync(targetRuntime, { recursive: true });
	if (existsSync(sourceRuntime)) {
		cpSync(sourceRuntime, targetRuntime, { recursive: true, force: true });
	}
	rmSync(join(targetRoot, "chats"), { recursive: true, force: true });
	mkdirSync(join(targetRoot, "chats"), { recursive: true });
}

function cloneAgentConfig(store: JsonNekoclawStore, source: AgentSpec): AgentSpec {
	const target = store.createAgent({
		slug: `${source.slug}-harness-${Date.now()}`,
		image: source.image,
	});
	cloneAgentWorkspace(store, source, target);
	const modelConfig = store.getModelConfig(source.agentId);
	if (modelConfig?.kind === "builtin") {
		store.setBuiltinModelConfig(target.agentId, {
			provider: modelConfig.provider,
			modelId: modelConfig.modelId,
			apiKey: modelConfig.apiKey,
			thinkingLevel: modelConfig.thinkingLevel,
		});
	} else if (modelConfig?.kind === "custom") {
		store.setCustomModelConfig(target.agentId, {
			baseUrl: modelConfig.baseUrl,
			api: modelConfig.api,
			providerId: modelConfig.providerId,
			modelId: modelConfig.modelId,
			apiKey: modelConfig.apiKey,
			thinkingLevel: modelConfig.thinkingLevel,
		});
		const runtimeModels = store.readRuntimeModelsConfig(source.agentId);
		if (runtimeModels) {
			store.writeRuntimeModelsConfig(target.agentId, runtimeModels, {
				copiedFrom: source.agentId,
				reason: "internal_chat_harness",
			});
		}
	}
	return store.updateAgent(target.agentId, { enabled: true, lastError: null });
}

async function createHarnessContext(options: InternalChatHarnessRunOptions): Promise<CurrentEnvHarnessContext> {
	const store = new JsonNekoclawStore();
	const source = store.getAgentByRef(options.agentRef);
	const agent = cloneAgentConfig(store, source);
	const fetchRegistry = installFetchRegistry();
	const plugins = new Map<string, ChannelPlugin>();
	const outboundDispatch = new OutboundDispatchService(store, plugins);
	const drivers = new Map<Exclude<HarnessChannel, "both">, HarnessDriver>();
	const requestedChannels: Array<Exclude<HarnessChannel, "both">> =
		options.channel === "both" || !options.channel ? ["telegram", "napcat"] : [options.channel];
	for (const channel of requestedChannels) {
		if (channel === "telegram") {
			const driver = new TelegramHarnessDriver(store, agent, (url, bytes) => fetchRegistry.register(url, bytes));
			drivers.set(channel, driver);
			plugins.set(getRuntimeKey(agent.agentId, channel), driver.plugin);
			continue;
		}
		const driver = new NapcatHarnessDriver(store, agent, (url, bytes) => fetchRegistry.register(url, bytes));
		drivers.set(channel, driver);
		plugins.set(getRuntimeKey(agent.agentId, channel), driver.plugin);
	}
	const workerRunner =
		options.executeJob === undefined
			? new WorkerRunnerService(
					store,
					outboundDispatch,
					plugins,
					async (agentRef) => {
						const current = store.getAgentByRef(agentRef);
						return ensureAgentContainer(current, store.getWorkspaceRoot(current.slug));
					},
				)
			: undefined;
	const jobQueue = new JobQueueService(
		store,
		new Map<string, RunJob[]>(),
		new Set<string>(),
		async (job) => {
			if (options.executeJob) {
				const result = await options.executeJob(job, {
					store,
					agent,
					outboundDispatch,
					jobQueue,
					plugins,
					drivers,
					timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					workspaceRoot: store.getWorkspaceRoot(agent.slug),
					createWorkspaceFixture(input) {
						const hostPath = join(store.getWorkspaceRoot(agent.slug), input.relativePath);
						mkdirSync(dirname(hostPath), { recursive: true });
						writeFileSync(hostPath, input.bytes);
						return {
							relativePath: input.relativePath,
							hostPath,
							containerPath: `${NEKOCLAW_CONTAINER_WORKSPACE_DIR}/${input.relativePath.replace(/\\/g, "/")}`,
						};
					},
				});
				const session = store.getSession(agent.agentId, job.sessionRecordId);
				if (result.toolActions?.length) {
					await outboundDispatch.executeToolActions(agent, session, result.toolActions);
				}
				if (result.outbound.text?.trim() || result.outbound.attachments?.length) {
					await outboundDispatch.sendToSession(agent, session, job.event, result.outbound);
				}
				return result;
			}
			assertCondition(workerRunner, "Expected a worker runner when executeJob override is not provided");
			return workerRunner.runJob(job);
		},
	);
	jobQueue.initialize();
	const commands = new CommandRouterService(store, (agentId) => jobQueue.getStatus(agentId));
	const messageRouter = new MessageRouterService(store, plugins, commands, (job) => jobQueue.enqueue(job));
	for (const [channel, driver] of drivers.entries()) {
		driver.plugin.startPolling({
			onEvent: async (event) => {
				await messageRouter.handleInbound(agent.agentId, channel, event);
			},
			onError: (error) => {
				store.updateAgent(agent.agentId, { lastError: error.message });
			},
		});
	}
	return {
		store,
		agent,
		outboundDispatch,
		jobQueue,
		plugins,
		drivers,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		workspaceRoot: store.getWorkspaceRoot(agent.slug),
		createWorkspaceFixture(input) {
			const hostPath = join(store.getWorkspaceRoot(agent.slug), input.relativePath);
			mkdirSync(dirname(hostPath), { recursive: true });
			writeFileSync(hostPath, input.bytes);
			return {
				relativePath: input.relativePath,
				hostPath,
				containerPath: `${NEKOCLAW_CONTAINER_WORKSPACE_DIR}/${input.relativePath.replace(/\\/g, "/")}`,
			};
		},
		_restoreFetchRegistry: fetchRegistry.restore,
	};
}

async function disposeHarnessContext(context: CurrentEnvHarnessContext): Promise<void> {
	const extended = context as CurrentEnvHarnessContext & { _restoreFetchRegistry?: () => void };
	for (const driver of context.drivers.values()) {
		driver.plugin.stop();
	}
	await removeAgentContainer(context.agent.containerName).catch(() => undefined);
	extended._restoreFetchRegistry?.();
}

function collectEvidence(context: ScenarioContext): InternalChatHarnessEvidence {
	return {
		transcript: tail(context.driver.getTranscript(), 40),
		pairs: context.store.listPairRequests(context.agent.agentId),
		queueTail: tail(context.store.getQueueEvents(context.agent.agentId), 20),
		auditTail: tail(context.store.getAuditEntries(context.agent.agentId), 20),
		sessionLogTail: readSessionLogTail(context.store, context.agent, 20),
		lastError: context.store.getAgentByRef(context.agent.agentId).lastError,
		sandboxAgentSlug: context.agent.slug,
	};
}

export async function runChatHarnessInCurrentEnvironment(
	options: InternalChatHarnessRunOptions,
): Promise<InternalChatHarnessReport> {
	const startedAt = nowIso();
	const context = await createHarnessContext(options);
	const baselineRuntimeModels = context.store.readRuntimeModelsConfig(context.agent.agentId);
	const picked = pickScenarioNames(options.scenario, SCENARIOS);
	const requestedChannels = options.channel === "both" || !options.channel ? new Set(["telegram", "napcat"]) : new Set([options.channel]);
	const results: InternalChatHarnessScenarioResult[] = [];
	try {
		for (const scenario of SCENARIOS) {
			if (!requestedChannels.has(scenario.channel)) {
				continue;
			}
			if (picked && !picked.has(scenario.name)) {
				continue;
			}
			const driver = context.drivers.get(scenario.channel);
			const start = Date.now();
			if (!driver) {
				results.push({
					name: scenario.name,
					channel: scenario.channel,
					status: "skipped",
					durationMs: Date.now() - start,
					evidence: {
						transcript: [],
						pairs: [],
						queueTail: [],
						auditTail: [],
						sessionLogTail: [],
						lastError: undefined,
						sandboxAgentSlug: context.agent.slug,
					},
				});
				continue;
			}
			driver.clearTranscript();
			await removeAgentContainer(context.agent.containerName);
			if (baselineRuntimeModels) {
				context.store.writeRuntimeModelsConfig(
					context.agent.agentId,
					JSON.parse(JSON.stringify(baselineRuntimeModels)) as Record<string, unknown>,
					{ reason: "scenario_reset" },
				);
			} else {
				rmSync(context.store.getRuntimeModelsPath(context.agent.slug), { force: true });
			}
			context.store.updateAgent(context.agent.agentId, { lastError: null });
			const scenarioContext: ScenarioContext = {
				...context,
				channel: scenario.channel,
				driver,
				dmChatId: String(100123 + results.length + 1),
				groupChatId: String(-100123 - (results.length + 1)),
				dmUserId: String(10001 + results.length + 1),
				groupUserId: String(20001 + results.length + 1),
				adminUserId: String(90001 + results.length + 1),
			};
			presetGroupTrigger(scenarioContext, "all");
			try {
				await scenario.run(scenarioContext);
				const outbound = [...driver.getTranscript()].reverse().find((entry) => entry.kind === "outbound");
				results.push({
					name: scenario.name,
					channel: scenario.channel,
					status: "passed",
					durationMs: Date.now() - start,
					outboundPreview: outbound?.text,
					evidence: collectEvidence(scenarioContext),
				});
			} catch (error) {
				results.push({
					name: scenario.name,
					channel: scenario.channel,
					status: "failed",
					durationMs: Date.now() - start,
					error: error instanceof Error ? error.message : String(error),
					outboundPreview:
						latestOutbound(driver, scenarioContext.dmChatId)?.text ??
						latestOutbound(driver, scenarioContext.groupChatId)?.text,
					evidence: collectEvidence(scenarioContext),
				});
			}
		}
	} finally {
		await disposeHarnessContext(context);
	}
	return {
		ok: results.every((result) => result.status !== "failed"),
		agentRef: options.agentRef,
		agentSlug: context.agent.slug,
		startedAt,
		finishedAt: nowIso(),
		results,
	};
}
