import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Document, Sort } from "mongodb";
import { getCollection, toApiDocument } from "../config/db";
import { recordAdminAction } from "../services/adminAudit.service";

const publicStatuses = ["ACTIVE", "PUBLISHED", "COMPLETED"];
const difficulties = ["Easy", "Medium", "Hard"];
const notDeleted = { deletedAt: { $exists: false }, isDeleted: { $ne: true } };

function computedStatus(challenge: Record<string, any>, now = new Date()) {
	const status = String(challenge.status ?? "DRAFT").toUpperCase();
	if (status === "DRAFT" || status === "ARCHIVED") return status;
	const start = asDate(challenge.startDate ?? challenge.createdAt);
	const end = asDate(challenge.endDate ?? challenge.deadline) ?? (start && challenge.durationDays ? new Date(start.getTime() + Number(challenge.durationDays) * 86_400_000) : null);
	if (start && start > now) return "UPCOMING";
	if (status === "COMPLETED" || (end && end < now)) return "COMPLETED";
	return "ACTIVE";
}

function asDate(value: unknown): Date | null {
	if (!value) return null;
	const parsed = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toPublicChallenge(challenge: Record<string, any>) {
	const { joinedUserIds: _privateJoinIds, ...fields } = challenge;
	const sdgNumbers = Array.isArray(challenge.sdgNumbers) && challenge.sdgNumbers.length
		? challenge.sdgNumbers.map(Number)
		: [Number(challenge.sdgId)].filter((id) => Number.isInteger(id) && id >= 1 && id <= 17);
	return {
		...toApiDocument(fields),
		sdgId: sdgNumbers[0] ?? Number(challenge.sdgId ?? 1),
		sdgNumbers,
		computedStatus: computedStatus(challenge),
		participants: Math.max(0, Number(challenge.participants ?? 0)),
	};
}

async function participantRows(challengeIds: string[]) {
	if (!challengeIds.length) return [];
	return (await getCollection("ChallengeParticipation")).find(
		{ challengeId: { $in: challengeIds }, status: { $ne: "WITHDRAWN" } },
		{ projection: { challengeId: 1, userId: 1, status: 1, progress: 1, joinedAt: 1 } },
	).toArray();
}

function withParticipants(challenge: Record<string, any>, rows: Array<Record<string, any>>, userId?: string) {
	const legacyIds = Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds.filter((id: unknown): id is string => typeof id === "string") : [];
	const challengeId = String(challenge._id);
	const rowsForChallenge = rows.filter((row) => String(row.challengeId) === challengeId);
	const participantIds = new Set([...legacyIds, ...rowsForChallenge.map((row) => String(row.userId))]);
	return {
		...toPublicChallenge(challenge),
		participants: participantIds.size,
		joined: Boolean(userId && (legacyIds.includes(userId) || rowsForChallenge.some((row) => String(row.userId) === userId))),
	};
}

function challengeDateExpressions() {
	const start = { $convert: { input: { $ifNull: ["$startDate", "$createdAt"] }, to: "date", onError: null, onNull: null } };
	const explicitEnd = { $convert: { input: { $ifNull: ["$endDate", "$deadline"] }, to: "date", onError: null, onNull: null } };
	const calculatedEnd = { $dateAdd: { startDate: start, unit: "day", amount: { $convert: { input: { $ifNull: ["$durationDays", 0] }, to: "int", onError: 0, onNull: 0 } } } };
	return { start, end: { $ifNull: [explicitEnd, calculatedEnd] } };
}

function parsePositiveInteger(value: unknown, fallback: number, max: number) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

export async function listChallenges(req: Request, res: Response) {
	const now = new Date();
	const rawStatus = typeof req.query.status === "string" ? req.query.status.toLowerCase() : "all";
	if (!["all", "active", "upcoming", "completed"].includes(rawStatus)) return res.status(400).json({ error: "status must be all, active, upcoming, or completed." });
	const rawDifficulty = typeof req.query.difficulty === "string" ? req.query.difficulty : "";
	if (rawDifficulty && !difficulties.includes(rawDifficulty)) return res.status(400).json({ error: "difficulty must be Easy, Medium, or Hard." });
	const rawSort = typeof req.query.sort === "string" ? req.query.sort : "newest";
	if (!["newest", "popular", "deadline"].includes(rawSort)) return res.status(400).json({ error: "sort must be newest, popular, or deadline." });

	const clauses: Document[] = [
		{ status: { $in: publicStatuses } },
		notDeleted,
	];
	if (process.env.NODE_ENV === "production") clauses.push({ isDemo: { $ne: true } });
	if (rawDifficulty) clauses.push({ difficulty: rawDifficulty });

	const requestedSdg = req.query.sdg ?? req.query.sdgId;
	if (requestedSdg !== undefined) {
		if (typeof requestedSdg !== "string") return res.status(400).json({ error: "sdg must be an integer between 1 and 17." });
		const sdg = Number(requestedSdg);
		if (!Number.isInteger(sdg) || sdg < 1 || sdg > 17) return res.status(400).json({ error: "sdg must be an integer between 1 and 17." });
		clauses.push({ $or: [{ sdgId: sdg }, { sdgNumbers: sdg }] });
	}

	const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
	if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
	if (search) {
		const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		clauses.push({ $or: [{ title: { $regex: escaped, $options: "i" } }, { description: { $regex: escaped, $options: "i" } }] });
	}

	const dates = challengeDateExpressions();
	if (rawStatus === "active") {
		clauses.push({ $expr: { $and: [{ $lte: [dates.start, now] }, { $gte: [dates.end, now] }] } });
		clauses.push({ status: { $in: ["ACTIVE", "PUBLISHED"] } });
	} else if (rawStatus === "upcoming") {
		clauses.push({ $expr: { $gt: [dates.start, now] } });
		clauses.push({ status: { $in: ["ACTIVE", "PUBLISHED"] } });
	} else if (rawStatus === "completed") {
		clauses.push({ $or: [{ status: "COMPLETED" }, { $expr: { $lt: [dates.end, now] } }] });
	}

	const mine = req.query.mine === "1" || req.query.mine === "true";
	if (mine) {
		if (!req.user) return res.status(401).json({ error: "Sign in to view your challenges." });
		const participations = await getCollection("ChallengeParticipation");
		const joinedIds = await participations.distinct("challengeId", { userId: req.user.id, status: { $ne: "WITHDRAWN" } });
		clauses.push({ $or: [{ _id: { $in: joinedIds } }, { joinedUserIds: req.user.id }] });
	}

	const page = parsePositiveInteger(req.query.page, 1, 1_000_000);
	const limit = parsePositiveInteger(req.query.limit, 9, 100);
	if (!page || !limit) return res.status(400).json({ error: "page and limit must be valid positive integers." });
	const filter = { $and: clauses };
	const sort = (rawSort === "popular" ? { participants: -1, createdAt: -1 } : rawSort === "deadline" ? { endDate: 1, deadline: 1, createdAt: -1 } : { createdAt: -1 }) as Sort;
	const challenges = await getCollection("Challenge");
	const [items, total] = await Promise.all([
		challenges.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
		challenges.countDocuments(filter),
	]);
	const ids = items.map((item) => String(item._id));
	const rows = await participantRows(ids);
	return res.json({
		items: items.map((item) => withParticipants(item, rows, req.user?.id)),
		pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
	});
}

export async function getChallengeStats(_req: Request, res: Response) {
	const challenges = await getCollection("Challenge");
	const baseFilter: Record<string, unknown> = { status: { $in: publicStatuses }, ...notDeleted };
	if (process.env.NODE_ENV === "production") baseFilter.isDemo = { $ne: true };
	const now = new Date();
	const dates = challengeDateExpressions();
	const [allChallenges, participationRecords, verifiedActions] = await Promise.all([
		challenges.find(baseFilter, { projection: { _id: 1, status: 1, startDate: 1, endDate: 1, deadline: 1, durationDays: 1, createdAt: 1, joinedUserIds: 1 } }).toArray(),
		(await getCollection("ChallengeParticipation")).find({ status: { $ne: "WITHDRAWN" } }, { projection: { challengeId: 1, userId: 1 } }).toArray(),
		(await getCollection("Activity")).countDocuments({ status: "VERIFIED", challengeId: { $exists: true, $nin: [null, ""] }, isDemo: { $ne: true } }),
	]);
	let activeChallenges = 0;
	let upcomingChallenges = 0;
	let completedChallenges = 0;
	const participantIds = new Set<string>();
	for (const challenge of allChallenges) {
		const state = computedStatus(challenge, now);
		if (state === "ACTIVE") activeChallenges += 1;
		if (state === "UPCOMING") upcomingChallenges += 1;
		if (state === "COMPLETED") completedChallenges += 1;
		for (const id of Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds : []) if (typeof id === "string") participantIds.add(id);
	}
	for (const record of participationRecords) if (typeof record.userId === "string") participantIds.add(record.userId);
	return res.json({ activeChallenges, upcomingChallenges, completedChallenges, participants: participantIds.size, verifiedActions });
}

export async function getChallenge(req: Request, res: Response) {
	const challenge = await (await getCollection("Challenge")).findOne({ _id: req.params.id, ...notDeleted });
	if (!challenge || !publicStatuses.includes(String(challenge.status).toUpperCase()) || (process.env.NODE_ENV === "production" && challenge.isDemo === true)) return res.status(404).json({ error: "Challenge not found." });
	const [rows, userActivities] = await Promise.all([
		participantRows([String(challenge._id)]),
		req.user ? (await getCollection("Activity")).find({ challengeId: String(challenge._id), userId: req.user.id, isDemo: { $ne: true } }, { projection: { status: 1 } }).toArray() : Promise.resolve([]),
	]);
	const participant = withParticipants(challenge, rows, req.user?.id);
	const verified = userActivities.filter((activity) => activity.status === "VERIFIED").length;
	const pending = userActivities.filter((activity) => activity.status === "PENDING" || activity.status === "NEEDS_INFO").length;
	const required = Math.max(1, Number(challenge.requiredSubmissions ?? 1));
	const completionPercent = Math.min(100, Math.round((verified / required) * 100));
	return res.json({
		...participant,
		instructions: Array.isArray(challenge.instructions) ? challenge.instructions : [],
		requirements: Array.isArray(challenge.requirements) ? challenge.requirements : [],
		myProgress: { submitted: userActivities.length, pending, verified, completionPercent, requiredSubmissions: required },
	});
}

export async function joinChallenge(req: Request, res: Response) {
	const challenges = await getCollection("Challenge");
	const challenge = await challenges.findOne({ _id: req.params.id, ...notDeleted });
	if (!challenge || (process.env.NODE_ENV === "production" && challenge.isDemo === true)) return res.status(404).json({ error: "Challenge not found." });
	if (computedStatus(challenge) !== "ACTIVE") return res.status(400).json({ error: "This challenge is not currently accepting participants." });

	const userId = req.user!.id;
	const challengeId = String(challenge._id);
	const legacyIds = Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds : [];
	const participations = await getCollection("ChallengeParticipation");
	const existing = await participations.findOne({ challengeId, userId });
	let newlyJoined = false;
	try {
		if (existing?.status === "WITHDRAWN") {
			const result = await participations.updateOne({ challengeId, userId, status: "WITHDRAWN" }, { $set: { status: "JOINED", rejoinedAt: new Date(), updatedAt: new Date() } });
			newlyJoined = result.modifiedCount > 0;
		} else if (!existing) {
			const result = await participations.updateOne(
				{ challengeId, userId },
				{ $setOnInsert: { _id: randomUUID(), challengeId, userId, status: "JOINED", progress: 0, joinedAt: new Date(), createdAt: new Date() } },
				{ upsert: true },
			);
			newlyJoined = result.upsertedCount > 0;
		}
		if (newlyJoined && !legacyIds.includes(userId)) await challenges.updateOne({ _id: challenge._id }, { $inc: { participants: 1 } });
	} catch (error) {
		if ((error as { code?: number }).code !== 11000) throw error;
	}
	const rows = await participantRows([challengeId]);
	return res.json({ id: challengeId, joined: true, participants: withParticipants(challenge, rows, userId).participants });
}

export async function withdrawChallenge(req: Request, res: Response) {
	const challenges = await getCollection("Challenge");
	const challenge = await challenges.findOne({ _id: req.params.id, ...notDeleted });
	if (!challenge) return res.status(404).json({ error: "Challenge not found." });
	const challengeId = String(challenge._id);
	const userId = req.user!.id;
	const participations = await getCollection("ChallengeParticipation");
	const existing = await participations.findOne({ challengeId, userId });
	const legacyJoined = Array.isArray(challenge.joinedUserIds) && challenge.joinedUserIds.includes(userId);
	if (!existing && !legacyJoined) return res.status(409).json({ error: "You have not joined this challenge." });

	let membershipChanged = false;
	if (existing?.status !== "WITHDRAWN") {
		const result = await participations.updateOne(
			{ challengeId, userId, status: { $ne: "WITHDRAWN" } },
			{
				$set: { status: "WITHDRAWN", withdrawnAt: new Date(), updatedAt: new Date() },
				$setOnInsert: { _id: randomUUID(), challengeId, userId, joinedAt: new Date(), createdAt: new Date(), progress: 0 },
			},
			{ upsert: !existing && legacyJoined },
		);
		membershipChanged = result.modifiedCount > 0 || result.upsertedCount > 0;
	}
	const legacyUpdate = await challenges.updateOne(
		{ _id: challenge._id, joinedUserIds: userId },
		[{ $set: { joinedUserIds: { $filter: { input: { $ifNull: ["$joinedUserIds", []] }, as: "memberId", cond: { $ne: ["$$memberId", userId] } } } } }],
	);
	membershipChanged ||= legacyUpdate.modifiedCount > 0;
	if (membershipChanged) {
		const latestChallenge = await challenges.findOne({ _id: challenge._id });
		const rows = await participantRows([challengeId]);
		await challenges.updateOne({ _id: challenge._id }, { $set: { participants: withParticipants(latestChallenge ?? challenge, rows).participants } });
	}
	return res.json({ id: challengeId, joined: false, withdrawn: true });
}

export async function getAdminChallenges(_req: Request, res: Response) {
	const items = await (await getCollection("Challenge")).find(notDeleted).sort({ createdAt: -1 }).toArray();
	const rows = await participantRows(items.map((item) => String(item._id)));
	return res.json(items.map((item) => withParticipants(item, rows)));
}

export async function createChallenge(req: Request, res: Response) {
	const now = new Date();
	const startDate = new Date(req.body.startDate);
	const endDate = new Date(req.body.endDate);
	if (startDate >= endDate) return res.status(400).json({ error: "The end date must be after the start date." });
	const slugBase = String(req.body.title).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "challenge";
	const id = randomUUID();
	const challenge = {
		_id: id,
		title: String(req.body.title).trim(),
		slug: `${slugBase}-${id.slice(0, 8)}`,
		description: String(req.body.description).trim(),
		instructions: req.body.instructions ?? [],
		requirements: req.body.requirements ?? [],
		sdgNumbers: req.body.sdgNumbers,
		sdgId: req.body.sdgNumbers[0],
		difficulty: req.body.difficulty,
		points: req.body.points,
		startDate,
		endDate,
		deadline: endDate,
		durationDays: Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000)),
		requiredSubmissions: req.body.requiredSubmissions ?? 1,
		status: "DRAFT",
		participants: 0,
		createdBy: req.user!.id,
		createdAt: now,
		updatedAt: now,
	};
	await (await getCollection("Challenge")).insertOne(challenge);
	await recordAdminAction(req.user!.id, "CHALLENGE_CREATED", "CHALLENGE", id, `Created draft challenge ${challenge.title}.`);
	return res.status(201).json(toApiDocument(challenge));
}

export async function updateChallenge(req: Request, res: Response) {
	const challenges = await getCollection("Challenge");
	const current = await challenges.findOne({ _id: req.params.id, ...notDeleted });
	if (!current) return res.status(404).json({ error: "Challenge not found." });
	const update: Record<string, unknown> = { updatedAt: new Date() };
	for (const key of ["title", "description", "instructions", "requirements", "sdgNumbers", "difficulty", "points", "requiredSubmissions", "status"] as const) {
		if (req.body[key] !== undefined) update[key] = req.body[key];
	}
	if (req.body.sdgNumbers) update.sdgId = req.body.sdgNumbers[0];
	if (req.body.startDate !== undefined) update.startDate = new Date(req.body.startDate);
	if (req.body.endDate !== undefined) { update.endDate = new Date(req.body.endDate); update.deadline = new Date(req.body.endDate); }
	const nextStart = asDate(update.startDate ?? current.startDate);
	const nextEnd = asDate(update.endDate ?? current.endDate ?? current.deadline);
	if (nextStart && nextEnd && nextStart >= nextEnd) return res.status(400).json({ error: "The end date must be after the start date." });
	if (update.status === "ACTIVE" && (!nextStart || !nextEnd)) return res.status(400).json({ error: "Set valid start and end dates before publishing." });
	const result = await challenges.updateOne({ _id: req.params.id }, { $set: update });
	if (!result.matchedCount) return res.status(404).json({ error: "Challenge not found." });
	const updated = await challenges.findOne({ _id: req.params.id });
	await recordAdminAction(req.user!.id, "CHALLENGE_UPDATED", "CHALLENGE", String(req.params.id), `Updated challenge ${current.title}.`);
	return res.json(toPublicChallenge(updated!));
}

export async function archiveChallenge(req: Request, res: Response) {
	const result = await (await getCollection("Challenge")).updateOne(
		{ _id: req.params.id, ...notDeleted },
		{ $set: { status: "ARCHIVED", updatedAt: new Date() } },
	);
	if (!result.matchedCount) return res.status(404).json({ error: "Challenge not found." });
	await recordAdminAction(req.user!.id, "CHALLENGE_ARCHIVED", "CHALLENGE", String(req.params.id), "Archived a challenge.");
	return res.json({ id: req.params.id, status: "ARCHIVED" });
}

export async function getChallengeParticipants(req: Request, res: Response) {
	const challenge = await (await getCollection("Challenge")).findOne({ _id: req.params.id, ...notDeleted });
	if (!challenge) return res.status(404).json({ error: "Challenge not found." });
	const records = await (await getCollection("ChallengeParticipation")).find({ challengeId: String(challenge._id), status: { $ne: "WITHDRAWN" } }).sort({ joinedAt: -1 }).toArray();
	const legacyIds = Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds.filter((id: unknown): id is string => typeof id === "string") : [];
	const recordIds = new Set(records.map((record) => String(record.userId)));
	const allIds = [...new Set([...recordIds, ...legacyIds])];
	const users = allIds.length ? await (await getCollection("User")).find({ _id: { $in: allIds } }, { projection: { name: 1, email: 1 } }).toArray() : [];
	const userMap = new Map(users.map((user) => [String(user._id), user]));
	const recordMap = new Map(records.map((record) => [String(record.userId), record]));
	return res.json(allIds.map((userId) => {
		const record = recordMap.get(userId);
		const user = userMap.get(userId);
		return { userId, name: user?.name ?? "SustainX member", email: user?.email ?? "", status: record?.status ?? "JOINED", progress: Number(record?.progress ?? 0), joinedAt: record?.joinedAt ?? null };
	}));
}
