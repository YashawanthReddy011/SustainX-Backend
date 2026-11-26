import type { Request, Response } from "express";
import { getCollection, toApiDocument } from "../config/db";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";
import { activeChallengeFilter, publishedProjectFilter } from "../services/impactMetrics.service";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function homeRecentActivities(req: Request, res: Response) {
	const filter: Record<string, unknown> = { status: "VERIFIED", isDemo: { $ne: true } };
	if (typeof req.query.sdgId === "string") {
		const sdgId = Number(req.query.sdgId);
		if (!Number.isInteger(sdgId) || sdgId < 1 || sdgId > 17) return res.status(400).json({ error: "sdgId must be an integer between 1 and 17." });
		filter.sdgId = sdgId;
	}
	if (typeof req.query.search === "string") {
		const search = req.query.search.trim();
		if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
		if (search) filter.title = { $regex: escapeRegex(search), $options: "i" };
	}
	const collection = await getCollection("Activity");
	const pagination = getApiPagination(req);
	const query = collection.find(filter).sort({ reviewedAt: -1, createdAt: -1 });
	if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
	const rows = await query.toArray();
	if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
	return res.json(rows.map(toApiDocument));
}

export async function getActivityById(req: Request, res: Response) {
	const activity = await (await getCollection("Activity")).findOne({ _id: req.params.id });
	if (!activity) return res.status(404).json({ error: "Submission not found." });
	if (activity.userId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "You cannot view this submission." });
	return res.json(toApiDocument(activity));
}

export async function sdgProgress(req: Request, res: Response) {
	const id = Number(req.params.id);
	if (!Number.isInteger(id) || id < 1 || id > 17) return res.status(400).json({ error: "SDG id must be an integer between 1 and 17." });
	const sdg = await (await getCollection("Sdg")).findOne({ _id: id }, { projection: { _id: 1, name: 1 } });
	if (!sdg) return res.status(404).json({ error: "SDG not found." });
	const [totalActions, verifiedActions] = await Promise.all([
		(await getCollection("Activity")).countDocuments({ sdgId: id, isDemo: { $ne: true } }),
		(await getCollection("Activity")).countDocuments({ sdgId: id, status: "VERIFIED", isDemo: { $ne: true } }),
	]);
	return res.json({ sdgId: id, title: sdg.name ?? `SDG ${id}`, totalActions, verifiedActions, progress: totalActions ? Math.round((verifiedActions / totalActions) * 100) : 0 });
}

export async function projectMembers(req: Request, res: Response) {
	const project = await (await getCollection("Project")).findOne({ _id: req.params.id }, { projection: { ownerId: 1, memberIds: 1 } });
	if (!project) return res.status(404).json({ error: "Project not found." });
	const ids = [...new Set([project.ownerId, ...(Array.isArray(project.memberIds) ? project.memberIds : [])].filter((id): id is string => typeof id === "string"))];
	if (!ids.includes(req.user!.id) && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Join this project to view its team." });
	const users = await (await getCollection("User")).find({ _id: { $in: ids } }, { projection: { name: 1, role: 1 } }).toArray();
	return res.json(users.map((user) => ({ id: String(user._id), name: user.name, role: user.role })));
}

export async function listNotifications(req: Request, res: Response) {
	const filter: Record<string, unknown> = { userId: req.user!.id };
	if (typeof req.query.read === "string") {
		if (req.query.read !== "true" && req.query.read !== "false") return res.status(400).json({ error: "read must be true or false." });
		filter.read = req.query.read === "true";
	}
	const collection = await getCollection("Notification");
	const pagination = getApiPagination(req);
	const query = collection.find(filter).sort({ createdAt: -1 });
	if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
	const notifications = await query.toArray();
	if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
	return res.json(notifications.map(toApiDocument));
}

export async function markNotificationsRead(req: Request, res: Response) {
	const ids = req.body.ids as string[] | undefined;
	const filter: Record<string, unknown> = { userId: req.user!.id, read: false };
	if (ids?.length) filter._id = { $in: ids };
	const result = await (await getCollection("Notification")).updateMany(filter, { $set: { read: true, readAt: new Date() } });
	return res.json({ updated: result.modifiedCount });
}

export async function listEnvironmentalActivities(req: Request, res: Response) {
	const filter: Record<string, unknown> = {};
	if (typeof req.query.type === "string") {
		const allowed = ["TREE_PLANTATION", "TREE_SURVIVAL", "WATER_CONSERVATION", "RENEWABLE_ENERGY", "WASTE_REDUCTION", "CLIMATE_ACTION", "MARINE_PROTECTION", "BIODIVERSITY"];
		if (!allowed.includes(req.query.type)) return res.status(400).json({ error: "type is not a supported EcoGuard activity." });
		filter.type = req.query.type;
	}
	const collection = await getCollection("environmentalActivities");
	const pagination = getApiPagination(req);
	const query = collection.find(filter).sort({ verifiedAt: -1 });
	if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
	const activities = await query.toArray();
	if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
	return res.json(activities.map(toApiDocument));
}

export async function analyticsImpact(_req: Request, res: Response) {
  const monthKeys = Array.from({ length: 12 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (11 - index));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const [verifiedActions, activeChallenges, impactProjects, monthlyRows] = await Promise.all([
    (await getCollection("Activity")).countDocuments({ status: "VERIFIED", isDemo: { $ne: true } }),
    (await getCollection("Challenge")).countDocuments(activeChallengeFilter()),
    (await getCollection("Project")).countDocuments(publishedProjectFilter()),
    (await getCollection("Activity")).aggregate<any>([
      { $match: { status: "VERIFIED", isDemo: { $ne: true } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: { $ifNull: ["$reviewedAt", "$createdAt"] }, timezone: "UTC", onNull: "unknown" } }, verifiedActions: { $sum: 1 } } },
      { $match: { _id: { $gte: monthKeys[0] } } },
    ]).toArray(),
	]);
  const byMonth = new Map<string, number>(monthlyRows.map((row: any) => [String(row._id), Number(row.verifiedActions)] as [string, number]));
	const monthlyVerifiedActions = Array.from({ length: 12 }, (_, index) => {
    const key = monthKeys[index];
		return { month: key, verifiedActions: byMonth.get(key) ?? 0 };
	});
	return res.json({ verifiedActions, activeChallenges, impactProjects, monthlyVerifiedActions });
}

export async function analyticsSdgs(_req: Request, res: Response) {
	const rows = await (await getCollection("Activity")).aggregate([
		{ $match: { status: "VERIFIED", isDemo: { $ne: true } } },
		{ $group: { _id: "$sdgId", verifiedActions: { $sum: 1 } } },
		{ $sort: { _id: 1 } },
	]).toArray();
	const sdgs = await (await getCollection("Sdg")).find({}, { projection: { _id: 1, name: 1 } }).toArray();
	const names = new Map(sdgs.map((sdg) => [Number(sdg._id), sdg.name ?? `SDG ${sdg._id}`]));
	return res.json(rows.map((row) => ({ sdgId: Number(row._id), title: names.get(Number(row._id)) ?? `SDG ${row._id}`, verifiedActions: Number(row.verifiedActions) })));
}
