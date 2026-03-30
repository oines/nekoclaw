import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { NEKOCLAW_RUNTIME_PAIRS_DIR } from "../config.js";
import type { ChannelType, ChatKind, PairRequest } from "../types.js";
import { readJsonFile, writeJsonFile } from "./fs.js";
import { ConfigRepository } from "./config-repository.js";
import { nowIso, readDirectoryJson, sixDigitCode } from "./helpers.js";
import { StorePaths } from "./paths.js";

export class PairStore {
	constructor(
		private readonly repo: ConfigRepository,
		private readonly paths: StorePaths,
	) {}

	listPairRequests(agentId?: string): PairRequest[] {
		this.expirePairs();
		return readDirectoryJson<PairRequest>(NEKOCLAW_RUNTIME_PAIRS_DIR)
			.filter((pair) => (agentId ? pair.agentId === agentId : true))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	createOrReusePair(
		agentRef: string,
		input: {
			channelType: ChannelType;
			externalConversationId: string;
			chatKind: ChatKind;
			threadId?: string;
			parentSessionKey?: string;
			sessionKey: string;
			senderId?: string;
			senderName?: string;
			chatTitle?: string;
			ttlMinutes?: number;
		},
	): PairRequest {
		const { config } = this.repo.getAgentEntry(agentRef);
		this.expirePairs();
		const existing = this.listPairRequests(config.agentId).find(
			(pair) =>
				pair.channelType === input.channelType &&
				pair.externalConversationId === input.externalConversationId &&
				pair.threadId === input.threadId &&
				pair.status === "pending",
		);
		if (existing) {
			return existing;
		}
		const createdAt = nowIso();
		const ttlMinutes = Math.max(1, input.ttlMinutes ?? this.repo.readConfig().pairing.ttlMinutes);
		let pair: PairRequest;
		const existingCodes = new Set(this.listPairRequests().map((entry) => entry.code));
		do {
			pair = {
				pairingId: randomUUID(),
				code: sixDigitCode(),
				agentId: config.agentId,
				channelType: input.channelType,
				externalConversationId: input.externalConversationId,
				chatKind: input.chatKind,
				sessionKey: input.sessionKey,
				parentSessionKey: input.parentSessionKey,
				threadId: input.threadId,
				senderId: input.senderId,
				senderName: input.senderName,
				chatTitle: input.chatTitle,
				status: "pending",
				createdAt,
				expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
				updatedAt: createdAt,
			};
		} while (existingCodes.has(pair.code));
		this.writePair(pair);
		return pair;
	}

	touchPairPrompt(pairingId: string): PairRequest {
		const pair = this.readPair(pairingId);
		const updated: PairRequest = {
			...pair,
			lastPromptedAt: nowIso(),
			updatedAt: nowIso(),
		};
		this.writePair(updated);
		return updated;
	}

	getPairByCode(code: string): PairRequest {
		this.expirePairs();
		const matches = this.listPairRequests().filter((pair) => pair.code === code);
		if (matches.length === 0) {
			throw new Error(`Unknown pairing code "${code}"`);
		}
		if (matches.length > 1) {
			throw new Error(`Pairing code "${code}" is ambiguous`);
		}
		return matches[0];
	}

	markAccepted(code: string): PairRequest {
		const pair = this.getPairByCode(code);
		if (pair.status !== "pending") {
			throw new Error(`Pairing code "${code}" is not pending`);
		}
		const updated: PairRequest = {
			...pair,
			status: "accepted",
			updatedAt: nowIso(),
		};
		this.writePair(updated);
		return updated;
	}

	markRejected(code: string): PairRequest {
		const pair = this.getPairByCode(code);
		if (pair.status !== "pending") {
			throw new Error(`Pairing code "${code}" is not pending`);
		}
		const updated: PairRequest = {
			...pair,
			status: "rejected",
			updatedAt: nowIso(),
		};
		this.writePair(updated);
		return updated;
	}

	deletePairsForAgent(agentId: string): void {
		for (const pair of this.listPairRequests(agentId)) {
			rmSync(this.paths.getPairPath(pair.pairingId), { force: true });
		}
	}

	private expirePairs(): void {
		const now = Date.now();
		for (const pair of this.listPairRequestsWithoutExpiring()) {
			if (pair.status === "pending" && new Date(pair.expiresAt).getTime() <= now) {
				this.writePair({
					...pair,
					status: "expired",
					updatedAt: nowIso(),
				});
			}
		}
	}

	private listPairRequestsWithoutExpiring(): PairRequest[] {
		return readDirectoryJson<PairRequest>(NEKOCLAW_RUNTIME_PAIRS_DIR);
	}

	private writePair(pair: PairRequest): void {
		writeJsonFile(this.paths.getPairPath(pair.pairingId), pair);
	}

	private readPair(pairingId: string): PairRequest {
		return readJsonFile<PairRequest>(this.paths.getPairPath(pairingId), {} as PairRequest);
	}
}
