import { randomUUID } from "node:crypto";
import type { Document, Sort } from "mongodb";
import type { Request, Response } from "express";
import { getCollection, getMongoClient, toApiDocument } from "../config/db";
import { recordAdminAction } from "../services/adminAudit.service";
import { rejectActivity, verifyActivity } from "../services/impact.service";
import { calculatePoints } from "../utils/points";

const categories = ["Environment", "Education", "Community", "Health", "Technology", "Agriculture", "Other"];
const hidden = { deletedAt: { $exists: false }, isDeleted: { $ne: true } };
const publicStatuses = ["PUBLISHED", "ACTIVE", "COMPLETED"];

function computedStatus(project: Record<string, any>, now = new Date()) {
	const status = String(project.status ?? "PENDING").toUpperCase();
	if (status === "ARCHIVED" || status === "REJECTED" || status === "PENDING" || status === "DRAFT") return status;
	const start = toDate(project.startDate);
	const end = toDate(project.endDate ?? project.deadline);
	if (start && start > now) return "UPCOMING";
	if (status === "COMPLETED" || (end && end < now)) return "COMPLETED";
	return "ACTIVE";
}

function toDate(value: unknown): Date | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(date.getTime()) ? null : date;
}

function publicProjectClause() {
	return { $or: [
		{ status: "PUBLISHED", visibility: { $ne: "PRIVATE" }, isPublished: { $ne: false } },
		{ status: { $in: ["ACTIVE", "COMPLETED"] }, visibility: { $ne: "PRIVATE" }, isPublished: { $ne: false } },
	] };
}

function projectDateExpressions() {
	const start = { $convert: { input: { $ifNull: ["$startDate", "$createdAt"] }, to: "date", onError: null, onNull: null } };
	const end = { $convert: { input: { $ifNull: ["$endDate", "$deadline"] }, to: "date", onError: null, onNull: null } };
	return { start, end };
}

function positiveInt(value: unknown, fallback: number, max: number) {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n <= max ? n : null;
}

function cleanProject(project: Record<string, any>) {
	const { memberIds: _memberIds, ...fields } = project;
	return toApiDocument(fields);
}

async function projectMembers(project: Record<string, any>) {
	const rows = await (await getCollection("ProjectMembership")).find({ projectId: String(project._id), status: "APPROVED" }).sort({ role: 1, joinedAt: 1 }).toArray();
	const legacyIds = Array.isArray(project.memberIds) ? project.memberIds.filter((id: unknown): id is string => typeof id === "string") : [];
	const userIds = [...new Set([String(project.ownerId ?? ""), ...rows.map((row) => String(row.userId)), ...legacyIds].filter(Boolean))];
	const users = userIds.length ? await (await getCollection("User")).find({ _id: { $in: userIds } }, { projection: { name: 1, email: 1, role: 1 } }).toArray() : [];
	const byId = new Map(users.map((user) => [String(user._id), user]));
	const rowById = new Map(rows.map((row) => [String(row.userId), row]));
	return userIds.map((id) => {
		const user = byId.get(id);
		const membership = rowById.get(id);
		return { id, membershipId: membership?._id, name: user?.name ?? "SustainX member", email: user?.email ?? "", role: membership?.role ?? (id === String(project.ownerId) ? "OWNER" : "MEMBER"), status: "APPROVED" };
	});
}

async function isProjectManager(project: Record<string, any>, userId: string, role?: string) {
	if (role === "ADMIN" || String(project.ownerId) === userId) return true;
	const membership = await (await getCollection("ProjectMembership")).findOne({ projectId: String(project._id), userId, status: "APPROVED", role: { $in: ["OWNER", "LEADER"] } });
	return Boolean(membership);
}

async function hasApprovedMembership(project: Record<string, any>, userId: string) {
	if (String(project.ownerId) === userId) return true;
	const membership = await (await getCollection("ProjectMembership")).findOne({ projectId: String(project._id), userId, status: "APPROVED" });
	const legacyIds = Array.isArray(project.memberIds) ? project.memberIds : [];
	return Boolean(membership || legacyIds.includes(userId));
}

async function syncParticipantCount(projectId: string) {
	const projects = await getCollection("Project");
	const project = await projects.findOne({ _id: projectId });
	if (!project) return 0;
	const memberIds = await (await getCollection("ProjectMembership")).distinct("userId", { projectId, status: "APPROVED" });
	const legacy = Array.isArray(project.memberIds) ? project.memberIds.filter((id: unknown): id is string => typeof id === "string") : [];
	const participants = new Set([String(project.ownerId ?? ""), ...memberIds.map(String), ...legacy].filter(Boolean)).size;
	await projects.updateOne({ _id: projectId }, { $set: { participantCount: participants, updatedAt: new Date() } });
	return participants;
}

async function calculateProjectProgress(projectId: string) {
	const result = await readProjectProgress(projectId);
	await (await getCollection("Project")).updateOne({ _id: projectId }, { $set: { progress: result.progress, updatedAt: new Date() } });
	return result;
}

async function readProjectProgress(projectId: string) {
	const milestones = await getCollection("ProjectMilestone");
	const [total, completed] = await Promise.all([
		milestones.countDocuments({ projectId }),
		milestones.countDocuments({ projectId, status: "COMPLETED" }),
	]);
	const progress = total ? Math.round((completed / total) * 100) : 0;
	return { progress, total, completed };
}

export async function listProjects(req: Request, res: Response) {
	const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL";
	if (!['ALL', 'ACTIVE', 'UPCOMING', 'COMPLETED', 'PENDING', 'DRAFT', 'REJECTED', 'ARCHIVED'].includes(status)) return res.status(400).json({ error: "Invalid project status filter." });
	const sortBy = typeof req.query.sort === "string" ? req.query.sort.toLowerCase() : "newest";
	if (!['newest', 'oldest', 'deadline', 'popular'].includes(sortBy)) return res.status(400).json({ error: "sort must be newest, oldest, deadline, or popular." });
	const category = typeof req.query.category === "string" ? req.query.category : "";
	if (category && category !== "ALL" && !categories.includes(category)) return res.status(400).json({ error: "Invalid project category." });
	const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
	if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
	const page = positiveInt(req.query.page, 1, 1_000_000);
	const limit = positiveInt(req.query.limit, 9, 100);
	if (!page || !limit) return res.status(400).json({ error: "page and limit must be valid positive integers." });
	const mine = req.query.mine === "1" || req.query.mine === "true";
	if (mine && !req.user) return res.status(401).json({ error: "Sign in to view your projects." });

	const clauses: Document[] = [hidden];
	if (process.env.NODE_ENV === "production") clauses.push({ isDemo: { $ne: true } });
	if (mine) {
		const membershipIds = await (await getCollection("ProjectMembership")).distinct("projectId", { userId: req.user!.id, status: { $nin: ["REMOVED", "REJECTED"] } });
		clauses.push({ $or: [{ ownerId: req.user!.id }, { _id: { $in: membershipIds } }, { memberIds: req.user!.id }] });
	} else clauses.push(publicProjectClause() as Document);

	const requestedSdg = req.query.sdg ?? req.query.sdgId;
	if (requestedSdg !== undefined) {
		if (typeof requestedSdg !== "string") return res.status(400).json({ error: "sdg must be an integer between 1 and 17." });
		const sdg = Number(requestedSdg);
		if (!Number.isInteger(sdg) || sdg < 1 || sdg > 17) return res.status(400).json({ error: "sdg must be an integer between 1 and 17." });
		clauses.push({ $or: [{ sdgId: sdg }, { sdgNumbers: sdg }] });
	}
	if (category && category !== "ALL") clauses.push({ category });
	if (search) {
		const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		clauses.push({ $or: [{ title: { $regex: escaped, $options: "i" } }, { description: { $regex: escaped, $options: "i" } }, { objectives: { $regex: escaped, $options: "i" } }] });
	}
	const now = new Date();
	const dates = projectDateExpressions();
	if (mine && ["PENDING", "DRAFT", "REJECTED", "ARCHIVED"].includes(status)) clauses.push({ status });
	else if (status === "ACTIVE") clauses.push({ $and: [{ status: { $in: ["PUBLISHED", "ACTIVE"] } }, { $expr: { $and: [{ $or: [{ $eq: [dates.start, null] }, { $lte: [dates.start, now] }] }, { $or: [{ $eq: [dates.end, null] }, { $gte: [dates.end, now] }] }] } }] });
	else if (status === "UPCOMING") clauses.push({ $and: [{ status: { $in: ["PUBLISHED", "ACTIVE"] } }, { $expr: { $gt: [dates.start, now] } }] });
	else if (status === "COMPLETED") clauses.push({ $or: [{ status: "COMPLETED" }, { $and: [{ status: { $in: ["PUBLISHED", "ACTIVE"] } }, { $expr: { $lt: [dates.end, now] } }] }] });
	else if (mine && status !== "ALL") clauses.push({ status });
	const filter = { $and: clauses };
	const sorts: Record<string, Sort> = {
		newest: { createdAt: -1 },
		oldest: { createdAt: 1 },
		deadline: { endDate: 1, createdAt: -1 },
		popular: { participantCount: -1, createdAt: -1 },
	};
	const collection = await getCollection("Project");
	const [rows, total] = await Promise.all([
		collection.find(filter).sort(sorts[sortBy]).skip((page - 1) * limit).limit(limit).toArray(),
		collection.countDocuments(filter),
	]);
	const membershipRows = rows.length ? await (await getCollection("ProjectMembership")).find({ projectId: { $in: rows.map((row) => String(row._id)) }, ...(req.user ? { $or: [{ status: "APPROVED" }, { userId: req.user.id }] } : { status: "APPROVED" }) }, { projection: { projectId: 1, userId: 1, status: 1 } }).toArray() : [];
	const counts = new Map<string, Set<string>>();
	const currentMembership = new Map<string, string>();
	for (const row of membershipRows) {
		const id = String(row.projectId);
		if (row.status === "APPROVED") {
			if (!counts.has(id)) counts.set(id, new Set());
			counts.get(id)!.add(String(row.userId));
		}
		if (req.user && String(row.userId) === req.user.id) currentMembership.set(id, String(row.status));
	}
	return res.json({
		items: rows.map((project) => {
			const id = String(project._id);
			const legacy = Array.isArray(project.memberIds) ? project.memberIds.filter((memberId: unknown): memberId is string => typeof memberId === "string") : [];
			const participants = new Set([String(project.ownerId ?? ""), ...(counts.get(id) ?? []), ...legacy].filter(Boolean));
			return { ...cleanProject(project), sdgNumbers: project.sdgNumbers ?? [project.sdgId].filter(Boolean), computedStatus: computedStatus(project), participantCount: participants.size, joined: Boolean(req.user && (String(project.ownerId) === req.user.id || participants.has(req.user.id))), membershipStatus: req.user ? currentMembership.get(id) ?? (String(project.ownerId) === req.user.id ? "APPROVED" : "NONE") : "NONE" };
		}),
		pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
	});
}

export async function getProjectStats(_req: Request, res: Response) {
	const projects = await getCollection("Project");
	const publicFilter = { $and: [hidden, publicProjectClause(), { isDemo: { $ne: true } }] };
	const now = new Date();
	const dates = projectDateExpressions();
	const [publishedProjects, activeProjects, upcomingProjects, completedProjects, participants, verifiedRows] = await Promise.all([
		projects.countDocuments(publicFilter),
		projects.countDocuments({ $and: [publicFilter, { status: { $in: ["PUBLISHED", "ACTIVE"] } }, { $expr: { $and: [{ $or: [{ $eq: [dates.start, null] }, { $lte: [dates.start, now] }] }, { $or: [{ $eq: [dates.end, null] }, { $gte: [dates.end, now] }] }] } }] }),
		projects.countDocuments({ $and: [publicFilter, { status: { $in: ["PUBLISHED", "ACTIVE"] } }, { $expr: { $gt: [dates.start, now] } }] }),
		projects.countDocuments({ $and: [publicFilter, { $or: [{ status: "COMPLETED" }, { $and: [{ status: { $in: ["PUBLISHED", "ACTIVE"] } }, { $expr: { $lt: [dates.end, now] } }] }] }] }),
		(await getCollection("ProjectMembership")).aggregate([
			{ $match: { status: "APPROVED" } },
			{ $lookup: { from: "Project", localField: "projectId", foreignField: "_id", as: "project" } },
			{ $unwind: "$project" },
			{ $match: { "project.status": { $in: publicStatuses }, "project.visibility": { $ne: "PRIVATE" }, "project.deletedAt": { $exists: false }, "project.isDeleted": { $ne: true }, "project.isDemo": { $ne: true } } },
			{ $group: { _id: "$userId" } }, { $count: "total" },
		]).toArray(),
		(await getCollection("ProjectEvidence")).aggregate([
			{ $match: { status: "APPROVED" } },
			{ $lookup: { from: "Project", localField: "projectId", foreignField: "_id", as: "project" } },
			{ $unwind: "$project" },
			{ $match: { "project.status": { $in: publicStatuses }, "project.visibility": { $ne: "PRIVATE" }, "project.deletedAt": { $exists: false }, "project.isDeleted": { $ne: true }, "project.isDemo": { $ne: true } } },
			{ $unwind: "$sdgNumbers" }, { $group: { _id: "$sdgNumbers" } }, { $count: "total" },
		]).toArray(),
	]);
	return res.json({ publishedProjects, activeProjects, upcomingProjects, completedProjects, uniqueParticipants: Number(participants[0]?.total ?? 0), verifiedSdgs: Number(verifiedRows[0]?.total ?? 0) });
}

export async function getProject(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project || (process.env.NODE_ENV === "production" && project.isDemo === true)) return res.status(404).json({ error: "Project not found." });
	const ownerOrAdmin = Boolean(req.user && (String(project.ownerId) === req.user.id || req.user.role === "ADMIN"));
	const publicProject = ["PUBLISHED", "ACTIVE", "COMPLETED"].includes(String(project.status).toUpperCase()) && String(project.visibility ?? "PUBLIC").toUpperCase() !== "PRIVATE" && project.isPublished !== false;
	const userMembership = req.user ? await (await getCollection("ProjectMembership")).findOne({ projectId: String(project._id), userId: req.user.id }) : null;
	const joined = Boolean(req.user && (String(project.ownerId) === req.user.id || userMembership?.status === "APPROVED" || (Array.isArray(project.memberIds) && project.memberIds.includes(req.user.id))));
	if (!publicProject && !ownerOrAdmin && !joined && userMembership?.status !== "INVITED") return res.status(404).json({ error: "Project not found." });
	const [owner, team, pendingMembers, milestones, discussions, activities, evidence, progress] = await Promise.all([
		(await getCollection("User")).findOne({ _id: String(project.ownerId) }, { projection: { name: 1 } }),
		projectMembers(project),
		ownerOrAdmin ? (await getCollection("ProjectMembership")).find({ projectId: String(project._id), status: "PENDING" }).sort({ createdAt: 1 }).toArray() : Promise.resolve([]),
		(await getCollection("ProjectMilestone")).find({ projectId: String(project._id) }).sort({ createdAt: 1 }).toArray(),
		joined ? (await getCollection("ProjectDiscussion")).find({ projectId: String(project._id) }).sort({ createdAt: -1 }).limit(100).toArray() : Promise.resolve([]),
		(await getCollection("Activity")).find({ projectId: String(project._id), status: "VERIFIED", isDemo: { $ne: true } }).sort({ reviewedAt: -1, createdAt: -1 }).limit(20).toArray(),
		(await getCollection("ProjectEvidence")).find(joined ? { projectId: String(project._id) } : { projectId: String(project._id), status: "APPROVED" }).sort({ createdAt: -1 }).limit(30).toArray(),
		readProjectProgress(String(project._id)),
	]);
	const pendingUserIds = pendingMembers.map((row) => String(row.userId));
	const pendingUsers = pendingUserIds.length ? await (await getCollection("User")).find({ _id: { $in: pendingUserIds } }, { projection: { name: 1, email: 1 } }).toArray() : [];
	const pendingById = new Map(pendingUsers.map((user) => [String(user._id), user]));
	const clean = cleanProject(project);
	return res.json({
		...clean,
		sdgNumbers: project.sdgNumbers ?? [project.sdgId].filter(Boolean),
		computedStatus: computedStatus(project),
		participantCount: team.length,
		ownerName: owner?.name ?? project.ownerName ?? "SustainX member",
		joined,
		membershipStatus: joined ? "APPROVED" : userMembership?.status ?? "NONE",
		team: team.map((member) => ({ ...member, email: ownerOrAdmin ? member.email : undefined })),
		membershipRequests: pendingMembers.map((member) => ({ id: String(member.userId), membershipId: String(member._id), name: pendingById.get(String(member.userId))?.name ?? "SustainX member", email: pendingById.get(String(member.userId))?.email ?? "", createdAt: member.createdAt })),
		milestones: milestones.map(toApiDocument),
		discussions: discussions.map(toApiDocument),
		activities: activities.map(toApiDocument),
		evidence: evidence.map(toApiDocument),
		progress: progress.progress,
	});
}

export async function getProjectMembers(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	const manager = await isProjectManager(project, req.user!.id, req.user!.role);
	const member = await hasApprovedMembership(project, req.user!.id);
	if (!manager && !member) return res.status(403).json({ error: "Join this project to view its team." });
	const team = await projectMembers(project);
	if (!manager) return res.json(team.map(({ email: _email, ...item }) => item));
	return res.json(team);
}

export async function createProject(req: Request, res: Response) {
	const now = new Date();
	const startDate = new Date(req.body.startDate);
	const endDate = new Date(req.body.endDate);
	if (startDate >= endDate) return res.status(400).json({ error: "The end date must be after the start date." });
	const sdgNumbers: number[] = req.body.sdgNumbers?.length ? [...new Set((req.body.sdgNumbers as unknown[]).map(Number))] : [Number(req.body.sdgId)];
	if (!sdgNumbers.length || sdgNumbers.some((sdg) => !Number.isInteger(sdg) || sdg < 1 || sdg > 17)) return res.status(400).json({ error: "Choose at least one valid SDG." });
	const owner = await (await getCollection("User")).findOne({ _id: req.user!.id }, { projection: { name: 1 } });
	const slugBase = String(req.body.title).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "project";
	const id = randomUUID();
	const project = {
		_id: id, slug: `${slugBase}-${id.slice(0, 8)}`, title: String(req.body.title).trim(), description: String(req.body.description).trim(),
		objectives: Array.isArray(req.body.objectives) ? req.body.objectives : [], category: req.body.category,
		sdgNumbers, sdgId: sdgNumbers[0], imageUrl: req.body.imageUrl ?? "", location: req.body.location ?? "",
		ownerId: req.user!.id, ownerName: owner?.name ?? "SustainX member", visibility: req.body.visibility ?? "PUBLIC",
		status: "PENDING", startDate, endDate, progress: 0, participantCount: 1,
		isPublished: false, createdAt: now, updatedAt: now,
	};
	const membership = { _id: randomUUID(), projectId: id, userId: req.user!.id, role: "OWNER", status: "APPROVED", joinedAt: now, createdAt: now, updatedAt: now };
	const client = await getMongoClient();
	const session = client.startSession();
	try {
		await session.withTransaction(async () => {
			await (await getCollection("Project")).insertOne(project, { session });
			await (await getCollection("ProjectMembership")).insertOne(membership, { session });
		});
	} finally { await session.endSession(); }
	return res.status(201).json({ ...toApiDocument(project), computedStatus: "PENDING", joined: true, participantCount: 1, message: "Project submitted for admin review." });
}

export async function joinProject(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project || !( ["PUBLISHED", "ACTIVE", "COMPLETED"].includes(String(project.status).toUpperCase()) )) return res.status(404).json({ error: "Project is unavailable." });
	const state = computedStatus(project);
	if (state !== "ACTIVE") return res.status(400).json({ error: "This project is not currently accepting team members." });
	if (String(project.ownerId) === req.user!.id) return res.status(409).json({ error: "You already own this project." });
	const memberships = await getCollection("ProjectMembership");
	const current = await memberships.findOne({ projectId: String(project._id), userId: req.user!.id });
	if (String(project.visibility ?? "PUBLIC").toUpperCase() === "PRIVATE" && current?.status !== "INVITED") return res.status(404).json({ error: "Project is unavailable." });
	if (current?.status === "APPROVED") return res.status(409).json({ error: "You are already a member of this project." });
	if (current?.status === "PENDING") return res.status(409).json({ error: "Your membership request is awaiting review." });
	const now = new Date();
	if (current?.status === "INVITED") {
		await memberships.updateOne({ _id: current._id, status: "INVITED" }, { $set: { status: "APPROVED", role: "MEMBER", joinedAt: now, reviewedAt: now, updatedAt: now } });
		await syncParticipantCount(String(project._id));
		return res.json({ id: String(project._id), status: "APPROVED", message: "Project invitation accepted." });
	}
	if (current) await memberships.updateOne({ _id: current._id, status: { $in: ["REJECTED", "REMOVED"] } }, { $set: { status: "PENDING", role: "MEMBER", requestedAt: now, updatedAt: now }, $unset: { reviewedAt: "", reviewedBy: "" } });
	else await memberships.insertOne({ _id: randomUUID(), projectId: String(project._id), userId: req.user!.id, role: "MEMBER", status: "PENDING", requestedAt: now, createdAt: now, updatedAt: now });
	if (project.ownerId) await (await getCollection("Notification")).insertOne({ _id: randomUUID(), userId: String(project.ownerId), title: "Project membership request", message: `A SustainX member requested to join ${project.title}.`, read: false, createdAt: now });
	return res.status(201).json({ id: String(project._id), status: "PENDING", message: "Membership request submitted to the project team." });
}

export async function updateProjectMembership(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (!(await isProjectManager(project, req.user!.id, req.user!.role))) return res.status(403).json({ error: "Only the project owner or an approved team leader can manage membership." });
	if (String(project.ownerId) === String(req.params.memberId)) return res.status(400).json({ error: "The project owner membership cannot be changed." });
	const memberships = await getCollection("ProjectMembership");
	const member = await memberships.findOne({ projectId: String(project._id), userId: String(req.params.memberId) });
	if (!member) return res.status(404).json({ error: "Membership request not found." });
	const status = String(req.body.status ?? "").toUpperCase();
	if (!['APPROVED', 'REJECTED', 'REMOVED'].includes(status)) return res.status(400).json({ error: "status must be APPROVED, REJECTED, or REMOVED." });
	if (req.user!.role !== "ADMIN" && req.user!.id !== String(project.ownerId) && req.body.role) return res.status(403).json({ error: "Only the project owner can assign team leader roles." });
	const oldApproved = member.status === "APPROVED";
	const role = req.body.role === "LEADER" ? "LEADER" : req.body.role === "MEMBER" ? "MEMBER" : member.role;
	await memberships.updateOne({ _id: member._id }, { $set: { status, role, reviewedBy: req.user!.id, reviewedAt: new Date(), updatedAt: new Date(), ...(status === "APPROVED" ? { joinedAt: member.joinedAt ?? new Date() } : {}) } });
	if (oldApproved !== (status === "APPROVED")) await syncParticipantCount(String(project._id));
	const userId = String(req.params.memberId);
	const notificationTitle = status === "APPROVED" ? "Project membership approved" : status === "REJECTED" ? "Project membership declined" : "Project membership removed";
	await (await getCollection("Notification")).insertOne({ _id: randomUUID(), userId, title: notificationTitle, message: `Your membership for ${project.title} is ${status.toLowerCase()}.`, read: false, createdAt: new Date() });
	return res.json({ userId, role, status });
}

export async function inviteProjectMember(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (!(await isProjectManager(project, req.user!.id, req.user!.role))) return res.status(403).json({ error: "Only the project owner or an approved team leader can invite members." });
	if (computedStatus(project) !== "ACTIVE") return res.status(400).json({ error: "Team invitations are only available while the project is active." });
	const email = String(req.body.email).trim().toLowerCase();
	const user = await (await getCollection("User")).findOne({ email });
	if (!user) return res.status(404).json({ error: "No SustainX account was found for that email." });
	if (String(project.ownerId) === String(user._id)) return res.status(409).json({ error: "The project owner is already a member." });
	const memberships = await getCollection("ProjectMembership");
	const existing = await memberships.findOne({ projectId: String(project._id), userId: String(user._id) });
	if (existing?.status === "APPROVED") return res.status(409).json({ error: "This user is already a project member." });
	const now = new Date();
	if (existing) await memberships.updateOne({ _id: existing._id }, { $set: { status: "INVITED", role: "MEMBER", invitedBy: req.user!.id, updatedAt: now } });
	else await memberships.insertOne({ _id: randomUUID(), projectId: String(project._id), userId: String(user._id), role: "MEMBER", status: "INVITED", invitedBy: req.user!.id, createdAt: now, updatedAt: now });
	await (await getCollection("Notification")).insertOne({ _id: randomUUID(), userId: String(user._id), title: "Project invitation", message: `You have been invited to join ${project.title}.`, read: false, createdAt: now });
	return res.status(201).json({ id: String(user._id), name: user.name, email: user.email, status: "PENDING" });
}

export async function removeProjectMember(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	const targetUserId = String(req.params.memberId);
	if (String(project.ownerId) === targetUserId) return res.status(400).json({ error: "The project owner cannot leave or be removed." });
	const selfLeave = targetUserId === req.user!.id;
	if (!selfLeave && !(await isProjectManager(project, req.user!.id, req.user!.role))) return res.status(403).json({ error: "Only the project owner or an approved team leader can remove members." });
	const memberships = await getCollection("ProjectMembership");
	const result = await memberships.updateOne({ projectId: String(project._id), userId: targetUserId, status: { $ne: "REMOVED" } }, { $set: { status: "REMOVED", updatedAt: new Date(), removedBy: req.user!.id } });
	if (!result.matchedCount) return res.status(404).json({ error: "Project membership not found." });
	await syncParticipantCount(String(project._id));
	return res.json({ removed: targetUserId });
}

export async function addProjectMilestone(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (!(await isProjectManager(project, req.user!.id, req.user!.role))) return res.status(403).json({ error: "Only project owners and approved leaders can manage milestones." });
	const now = new Date();
	const milestone = { _id: randomUUID(), projectId: String(project._id), title: req.body.title, description: req.body.description ?? "", dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null, assignedTo: req.body.assignedTo ?? null, status: "PENDING", createdAt: now, updatedAt: now };
	await (await getCollection("ProjectMilestone")).insertOne(milestone);
	await calculateProjectProgress(String(project._id));
	return res.status(201).json(toApiDocument(milestone));
}

export async function updateProjectMilestone(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (!(await isProjectManager(project, req.user!.id, req.user!.role))) return res.status(403).json({ error: "Only project owners and approved leaders can manage milestones." });
	const milestones = await getCollection("ProjectMilestone");
	const current = await milestones.findOne({ _id: String(req.params.milestoneId), projectId: String(project._id) });
	if (!current) return res.status(404).json({ error: "Project milestone not found." });
	const set: Record<string, unknown> = { updatedAt: new Date() };
	for (const field of ["title", "description", "dueDate", "assignedTo", "status"] as const) if (req.body[field] !== undefined) set[field] = field === "dueDate" && req.body[field] ? new Date(req.body[field]) : req.body[field];
	if (req.body.status === "COMPLETED" && current.status !== "COMPLETED") set.completedAt = new Date();
	if (req.body.status && req.body.status !== "COMPLETED") set.completedAt = null;
	await milestones.updateOne({ _id: current._id }, { $set: set });
	await calculateProjectProgress(String(project._id));
	return res.json(toApiDocument((await milestones.findOne({ _id: current._id }))!));
}

export async function addProjectDiscussion(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (!(await hasApprovedMembership(project, req.user!.id))) return res.status(403).json({ error: "Only approved project members can post to the team discussion." });
	const user = await (await getCollection("User")).findOne({ _id: req.user!.id }, { projection: { name: 1 } });
	const discussion = { _id: randomUUID(), projectId: String(project._id), userId: req.user!.id, authorName: user?.name ?? "SustainX member", message: req.body.message, createdAt: new Date() };
	await (await getCollection("ProjectDiscussion")).insertOne(discussion);
	return res.status(201).json(toApiDocument(discussion));
}

export async function updateProject(req: Request, res: Response) {
	const projects = await getCollection("Project");
	const project = await projects.findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (!(await isProjectManager(project, req.user!.id, req.user!.role))) return res.status(403).json({ error: "Only the project owner or an approved team leader can edit this project." });
	const set: Record<string, unknown> = { updatedAt: new Date() };
	for (const field of ["title", "description", "objectives", "category", "location", "imageUrl", "startDate", "endDate", "visibility"] as const) if (req.body[field] !== undefined) set[field] = ["startDate", "endDate"].includes(field) && req.body[field] ? new Date(req.body[field]) : req.body[field];
	const sdgNumbers = req.body.sdgNumbers?.length ? [...new Set(req.body.sdgNumbers)] : req.body.sdgId ? [req.body.sdgId] : undefined;
	if (sdgNumbers) { set.sdgNumbers = sdgNumbers; set.sdgId = sdgNumbers[0]; }
	const nextStart = toDate(set.startDate ?? project.startDate);
	const nextEnd = toDate(set.endDate ?? project.endDate ?? project.deadline);
	if (nextStart && nextEnd && nextStart >= nextEnd) return res.status(400).json({ error: "The end date must be after the start date." });
	if (project.status === "REJECTED") { set.status = "PENDING"; set.reviewNote = null; set.isPublished = false; }
	await projects.updateOne({ _id: project._id }, { $set: set });
	return res.json(cleanProject((await projects.findOne({ _id: project._id }))!));
}

export async function deleteProject(req: Request, res: Response) {
	const projects = await getCollection("Project");
	const project = await projects.findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (String(project.ownerId) !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Only the project owner can archive this project." });
	await projects.updateOne({ _id: project._id }, { $set: { status: "ARCHIVED", archivedAt: new Date(), updatedAt: new Date(), isPublished: false } });
	return res.json({ id: String(project._id), status: "ARCHIVED" });
}

export async function submitProjectEvidence(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id), ...hidden });
	if (!project) return res.status(404).json({ error: "Project not found." });
	if (!(await hasApprovedMembership(project, req.user!.id))) return res.status(403).json({ error: "Only approved project members can submit project evidence." });
	const milestoneId = req.body.milestoneId ? String(req.body.milestoneId) : "";
	if (milestoneId && !(await getCollection("ProjectMilestone")).findOne({ _id: milestoneId, projectId: String(project._id) })) return res.status(400).json({ error: "The selected milestone does not belong to this project." });
	const evidenceId = randomUUID();
	const activityId = randomUUID();
	const now = new Date();
	const sdgNumbers = Array.isArray(project.sdgNumbers) && project.sdgNumbers.length ? project.sdgNumbers : [Number(project.sdgId)];
	const urls: string[] = req.body.evidenceUrls ?? [];
	const evidence = { _id: evidenceId, projectId: String(project._id), milestoneId: milestoneId || null, submittedBy: req.user!.id, description: req.body.description, files: urls.map((url) => ({ url, resourceType: "image" })), sdgNumbers, status: "PENDING", activityId, createdAt: now, updatedAt: now };
	const activity = { _id: activityId, title: `Project evidence: ${project.title}`, description: req.body.description, location: project.location || "Project activity", evidenceUrl: urls[0] ?? "", quantity: 1, points: calculatePoints(1), userId: req.user!.id, sdgId: sdgNumbers[0], projectId: String(project._id), category: "Project Evidence", status: "PENDING", createdAt: now, reviewedAt: null, reviewNote: null };
	const client = await getMongoClient();
	const session = client.startSession();
	try {
		await session.withTransaction(async () => {
			await (await getCollection("ProjectEvidence")).insertOne(evidence, { session });
			await (await getCollection("Activity")).insertOne(activity, { session });
		});
	} finally { await session.endSession(); }
	return res.status(201).json(toApiDocument(evidence));
}

export async function getAdminProjects(req: Request, res: Response) {
	const filter: Record<string, unknown> = { ...hidden, isDemo: { $ne: true } };
	if (typeof req.query.status === "string" && req.query.status !== "ALL") filter.status = req.query.status.toUpperCase();
	const items = await (await getCollection("Project")).find(filter).sort({ createdAt: -1 }).limit(200).toArray();
	const owners = await (await getCollection("User")).find({ _id: { $in: items.map((item) => String(item.ownerId)) } }, { projection: { name: 1, email: 1 } }).toArray();
	const ownerMap = new Map(owners.map((owner) => [String(owner._id), owner]));
	const memberships = items.length ? await (await getCollection("ProjectMembership")).find({ projectId: { $in: items.map((item) => String(item._id)) }, status: "APPROVED" }, { projection: { projectId: 1, userId: 1 } }).toArray() : [];
	const countMap = new Map<string, Set<string>>();
	for (const member of memberships) { const id = String(member.projectId); if (!countMap.has(id)) countMap.set(id, new Set()); countMap.get(id)!.add(String(member.userId)); }
	return res.json(items.map((project) => ({ ...cleanProject(project), ownerName: ownerMap.get(String(project.ownerId))?.name ?? project.ownerName ?? "SustainX member", ownerEmail: ownerMap.get(String(project.ownerId))?.email ?? "", participantCount: countMap.get(String(project._id))?.size ?? 0, computedStatus: computedStatus(project) })));
}

export async function reviewProject(req: Request, res: Response) {
	const decision = String(req.body.decision).toUpperCase();
	if (!['PUBLISH', 'REJECT', 'ARCHIVE'].includes(decision)) return res.status(400).json({ error: "decision must be PUBLISH, REJECT, or ARCHIVE." });
	const status = decision === "PUBLISH" ? "PUBLISHED" : decision === "REJECT" ? "REJECTED" : "ARCHIVED";
	const now = new Date();
	const update = { status, isPublished: decision === "PUBLISH", updatedAt: now, reviewedBy: req.user!.id, reviewedAt: now, reviewNote: req.body.reviewNote ?? "", ...(decision === "PUBLISH" ? { publishedAt: now } : {}) };
	const result = await (await getCollection("Project")).updateOne({ _id: String(req.params.id), status: { $in: ["PENDING", "REJECTED", "PUBLISHED", "ACTIVE", "COMPLETED"] }, ...hidden }, { $set: update });
	if (!result.matchedCount) return res.status(404).json({ error: "Project awaiting review was not found." });
	const project = await (await getCollection("Project")).findOne({ _id: String(req.params.id) });
	await recordAdminAction(req.user!.id, `PROJECT_${decision}`, "PROJECT", String(req.params.id), `${project?.title ?? "Project"} was ${status.toLowerCase()}.`);
	if (project?.ownerId) await (await getCollection("Notification")).insertOne({ _id: randomUUID(), userId: String(project.ownerId), title: decision === "PUBLISH" ? "Project approved" : decision === "REJECT" ? "Project needs changes" : "Project archived", message: req.body.reviewNote || `${project.title} was ${status.toLowerCase()} by an administrator.`, read: false, createdAt: now });
	return res.json({ ...cleanProject(project!), computedStatus: computedStatus(project!) });
}

export async function listAdminProjectEvidence(_req: Request, res: Response) {
	const rows = await (await getCollection("ProjectEvidence")).find({ status: "PENDING" }).sort({ createdAt: 1 }).limit(200).toArray();
	const projects = rows.length ? await (await getCollection("Project")).find({ _id: { $in: rows.map((row) => String(row.projectId)) } }, { projection: { title: 1, ownerName: 1 } }).toArray() : [];
	const users = rows.length ? await (await getCollection("User")).find({ _id: { $in: rows.map((row) => String(row.submittedBy)) } }, { projection: { name: 1, email: 1 } }).toArray() : [];
	const projectMap = new Map(projects.map((item) => [String(item._id), item]));
	const userMap = new Map(users.map((item) => [String(item._id), item]));
	return res.json(rows.map((row) => ({ ...toApiDocument(row), projectTitle: projectMap.get(String(row.projectId))?.title ?? "Archived project", submitterName: userMap.get(String(row.submittedBy))?.name ?? "SustainX member", submitterEmail: userMap.get(String(row.submittedBy))?.email ?? "" })));
}

export async function reviewProjectEvidence(req: Request, res: Response) {
	const status = String(req.body.status).toUpperCase();
	if (!['APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ error: "status must be APPROVED or REJECTED." });
	const evidenceCollection = await getCollection("ProjectEvidence");
	const evidence = await evidenceCollection.findOne({ _id: String(req.params.id), status: "PENDING" });
	if (!evidence) return res.status(404).json({ error: "Pending project evidence was not found." });
	const claim = await evidenceCollection.updateOne({ _id: evidence._id, status: "PENDING" }, { $set: { status: "REVIEWING", reviewStartedBy: req.user!.id, reviewStartedAt: new Date() } });
	if (!claim.modifiedCount) return res.status(409).json({ error: "Another administrator is already reviewing this submission." });
	try {
		if (evidence.activityId) {
			if (status === "APPROVED") await verifyActivity(String(evidence.activityId), req.body.reviewComment);
			else await rejectActivity(String(evidence.activityId), req.body.reviewComment);
		}
	} catch (error) {
		await evidenceCollection.updateOne({ _id: evidence._id, status: "REVIEWING" }, { $set: { status: "PENDING" }, $unset: { reviewStartedBy: "", reviewStartedAt: "" } });
		throw error;
	}
	const now = new Date();
	const reviewed = await evidenceCollection.updateOne({ _id: evidence._id, status: "REVIEWING" }, { $set: { status, reviewedBy: req.user!.id, reviewedAt: now, reviewComment: req.body.reviewComment ?? "", updatedAt: now }, $unset: { reviewStartedBy: "", reviewStartedAt: "" } });
	if (!reviewed.modifiedCount) return res.status(409).json({ error: "This project evidence review could not be completed." });
	await recordAdminAction(req.user!.id, `PROJECT_EVIDENCE_${status}`, "PROJECT_EVIDENCE", String(evidence._id), `Project evidence was ${status.toLowerCase()}.`);
	if (status === "REJECTED") await (await getCollection("Notification")).insertOne({ _id: randomUUID(), userId: String(evidence.submittedBy), title: "Project evidence needs changes", message: req.body.reviewComment || "Your submitted project evidence was returned for changes.", read: false, createdAt: now });
	return res.json(toApiDocument((await evidenceCollection.findOne({ _id: evidence._id }))!));
}
