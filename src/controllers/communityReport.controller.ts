import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { getCollection, toApiDocument } from "../config/db";
import { getApiPagination } from "../middleware/apiV1";
import { recordAdminAction } from "../services/adminAudit.service";

export const COMMUNITY_REPORT_CATEGORIES = [
	"Waste Management", "Water & Sanitation", "Roads & Infrastructure", "Public Safety",
	"Environment", "Pollution", "Public Facilities", "Other",
] as const;

const statusAliases: Record<string, string[]> = {
	SUBMITTED: ["SUBMITTED", "REPORTED"], REPORTED: ["REPORTED", "SUBMITTED"],
	UNDER_REVIEW: ["UNDER_REVIEW"], INVESTIGATING: ["INVESTIGATING", "IN_PROGRESS"], IN_PROGRESS: ["IN_PROGRESS", "INVESTIGATING"],
	RESOLVED: ["RESOLVED"], REJECTED: ["REJECTED"],
};
const categoryAliases: Record<string, string[]> = {
	"Waste Management": ["Waste Management", "Waste"],
	"Water & Sanitation": ["Water & Sanitation", "Water and Sanitation"],
	"Roads & Infrastructure": ["Roads & Infrastructure", "Infrastructure", "Roads", "Civic Infrastructure"],
	"Public Safety": ["Public Safety"], Environment: ["Environment"], Pollution: ["Pollution"], "Public Facilities": ["Public Facilities"], Other: ["Other"],
};

function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function canonicalStatus(value: unknown) {
	const status = String(value ?? "SUBMITTED").toUpperCase();
	return status === "REPORTED" ? "SUBMITTED" : status === "IN_PROGRESS" ? "INVESTIGATING" : status;
}

function canonicalCategory(value: unknown) {
	const category = String(value ?? "Other");
	if (["Infrastructure", "Roads"].includes(category)) return "Roads & Infrastructure";
	if (category === "Water and Sanitation") return "Water & Sanitation";
	if (category === "Waste") return "Waste Management";
	return COMMUNITY_REPORT_CATEGORIES.includes(category as typeof COMMUNITY_REPORT_CATEGORIES[number]) ? category : "Other";
}

function serializeReport(report: Record<string, any>, userId?: string) {
	const votes = Array.isArray(report.upvotes) ? report.upvotes : [];
	const { upvotes: _privateVotes, createdBy: _privateCreator, ...fields } = report;
	const history = Array.isArray(report.statusHistory) ? report.statusHistory.map((entry: Record<string, any>) => ({ status: canonicalStatus(entry.status), ...(entry.changedByName ? { changedByName: entry.changedByName } : {}), note: entry.note ?? "", createdAt: entry.createdAt })) : [];
	const comments = Array.isArray(report.comments) ? report.comments.map((entry: Record<string, any>) => ({ id: entry.id, authorName: entry.authorName ?? "SustainX member", message: entry.message ?? "", createdAt: entry.createdAt })) : [];
	const coordinates = Array.isArray(report.geoPoint?.coordinates) ? report.geoPoint.coordinates : null;
	const latitude = typeof report.latitude === "number" ? report.latitude : coordinates?.[1];
	const longitude = typeof report.longitude === "number" ? report.longitude : coordinates?.[0];
	return {
		...toApiDocument(fields), category: canonicalCategory(report.category), status: canonicalStatus(report.status), statusHistory: history,
		...(latitude !== undefined ? { latitude } : {}), ...(longitude !== undefined ? { longitude } : {}),
		upvotes: votes.length, upvoted: Boolean(userId && votes.includes(userId)), comments,
	};
}

async function queryReports(req: Request, res: Response, scope: "PUBLIC" | "MINE" | "ADMIN") {
	const filter: Record<string, any> = { deletedAt: { $exists: false }, isDeleted: { $ne: true }, isDemo: { $ne: true } };
	if (scope === "MINE") filter.createdBy = req.user!.id;
	if (scope === "PUBLIC") filter.status = { $ne: "REJECTED" };

	if (typeof req.query.status === "string" && req.query.status !== "ALL") {
		const status = req.query.status.toUpperCase();
		const aliases = statusAliases[status];
		if (!aliases) return res.status(400).json({ error: "Unsupported report status." });
		if (status === "REJECTED" && scope === "PUBLIC") return res.status(403).json({ error: "Rejected reports are visible to their reporter and administrators." });
		filter.status = { $in: aliases };
	}
	if (typeof req.query.category === "string" && req.query.category !== "ALL") {
		if (!COMMUNITY_REPORT_CATEGORIES.includes(req.query.category as typeof COMMUNITY_REPORT_CATEGORIES[number])) return res.status(400).json({ error: "Unsupported report category." });
		filter.category = { $in: categoryAliases[req.query.category] ?? [req.query.category] };
	}
	if (typeof req.query.search === "string") {
		const search = req.query.search.trim();
		if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
		if (search) {
			const pattern = { $regex: escapeRegex(search), $options: "i" };
			filter.$or = [{ title: pattern }, { description: pattern }, { location: pattern }];
		}
	}
	if (typeof req.query.from === "string" || typeof req.query.to === "string") {
		const fromValue = typeof req.query.from === "string" ? req.query.from : null;
		const toValue = typeof req.query.to === "string" ? req.query.to : null;
		const from = fromValue ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(fromValue) ? `${fromValue}T00:00:00.000Z` : fromValue) : null;
		const to = toValue ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(toValue) ? `${toValue}T23:59:59.999Z` : toValue) : null;
		if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to)) return res.status(400).json({ error: "Invalid report date range." });
		filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
	}

	const pagination = getApiPagination(req);
	const page = pagination.enabled ? pagination.page : 1;
	const limit = pagination.enabled ? pagination.limit : 100;
	const reports = await getCollection("CommunityReport");
	const [items, total] = await Promise.all([
		reports.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
		reports.countDocuments(filter),
	]);
	return res.json({ items: items.map((report) => serializeReport(report, req.user?.id)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function listReports(req: Request, res: Response) { return queryReports(req, res, "PUBLIC"); }
export async function listMyReports(req: Request, res: Response) { return queryReports(req, res, "MINE"); }
export async function listAdminReports(req: Request, res: Response) { return queryReports(req, res, "ADMIN"); }

export async function getCommunityReportStats(_req: Request, res: Response) {
	const reports = await getCollection("CommunityReport");
	const match = { deletedAt: { $exists: false }, isDeleted: { $ne: true }, isDemo: { $ne: true } };
	const [rows, total] = await Promise.all([
		reports.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
		reports.countDocuments(match),
	]);
	const counts = new Map(rows.map((row) => [String(row._id).toUpperCase(), Number(row.count)]));
	const submitted = (counts.get("SUBMITTED") ?? 0) + (counts.get("REPORTED") ?? 0);
	const underReview = counts.get("UNDER_REVIEW") ?? 0;
	const investigating = (counts.get("INVESTIGATING") ?? 0) + (counts.get("IN_PROGRESS") ?? 0);
	const resolved = counts.get("RESOLVED") ?? 0;
	const rejected = counts.get("REJECTED") ?? 0;
	const actionable = total - rejected;
	return res.json({ total, submitted, underReview, investigating, resolved, rejected, resolutionRate: actionable ? Math.round((resolved / actionable) * 100) : 0 });
}

export async function getReport(req: Request, res: Response) {
	const report = await (await getCollection("CommunityReport")).findOne({ _id: req.params.id, deletedAt: { $exists: false }, isDeleted: { $ne: true } });
	if (!report || report.isDemo === true) return res.status(404).json({ error: "Community report not found." });
	if (canonicalStatus(report.status) === "REJECTED" && report.createdBy !== req.user?.id && req.user?.role !== "ADMIN") return res.status(404).json({ error: "Community report not found." });
	return res.json(serializeReport(report, req.user?.id));
}

export async function createReport(req: Request, res: Response) {
	const now = new Date();
	const title = String(req.body.title).trim();
	const location = String(req.body.location).trim();
	const reports = await getCollection("CommunityReport");
	const duplicate = await reports.findOne({ createdBy: req.user!.id, title: { $regex: "^" + escapeRegex(title) + "$", $options: "i" }, location: { $regex: "^" + escapeRegex(location) + "$", $options: "i" }, createdAt: { $gte: new Date(now.getTime() - 5 * 60_000) } });
	if (duplicate) return res.status(409).json({ error: "A matching report was submitted recently." });
	const latitude = req.body.latitude;
	const longitude = req.body.longitude;
	const report = {
		_id: randomUUID(), title, description: String(req.body.description).trim(), category: req.body.category, location,
		...(Number.isFinite(latitude) ? { latitude } : {}), ...(Number.isFinite(longitude) ? { longitude } : {}),
		...(Number.isFinite(latitude) && Number.isFinite(longitude) ? { geoPoint: { type: "Point", coordinates: [longitude, latitude] } } : {}),
		...(Array.isArray(req.body.imageUrls) ? { imageUrls: req.body.imageUrls } : {}),
		...(Array.isArray(req.body.sdgNumbers) ? { sdgNumbers: [...new Set(req.body.sdgNumbers)] } : {}),
		status: "SUBMITTED", createdAt: now, createdBy: req.user!.id, upvotes: [], comments: [],
		statusHistory: [{ status: "SUBMITTED", changedBy: req.user!.id, note: "Report submitted", createdAt: now }],
	};
	await reports.insertOne(report);
	return res.status(201).json(serializeReport(report, req.user!.id));
}

export async function updateReportStatus(req: Request, res: Response) {
	const reports = await getCollection("CommunityReport");
	const report = await reports.findOne({ _id: req.params.id, deletedAt: { $exists: false }, isDeleted: { $ne: true } });
	if (!report) return res.status(404).json({ error: "Report not found." });
	const status = canonicalStatus(req.body.status);
	const moderator = await (await getCollection("User")).findOne({ _id: req.user!.id }, { projection: { name: 1 } });
	const changedAt = new Date();
	const note = String(req.body.resolutionDetails || req.body.reviewNote || "").trim();
	const statusChanged = canonicalStatus(report.status) !== status;
	const set: Record<string, unknown> = {
		status, reviewedAt: changedAt, reviewNote: req.body.reviewNote ?? "",
		...(req.body.resolutionDetails !== undefined ? { resolutionDetails: req.body.resolutionDetails } : {}),
		...(req.body.resolutionEvidenceUrl !== undefined ? { resolutionEvidenceUrl: req.body.resolutionEvidenceUrl } : {}),
		...(statusChanged ? { statusHistory: [...(Array.isArray(report.statusHistory) ? report.statusHistory : []), { status, changedBy: req.user!.id, changedByName: moderator?.name ?? "Moderator", note, createdAt: changedAt }] } : {}),
	};
	const result = await reports.updateOne({ _id: req.params.id, status: report.status }, { $set: set });
	if (!result.matchedCount) return res.status(409).json({ error: "This report changed during review. Reload and try again." });
	if (report.createdBy && statusChanged) await (await getCollection("Notification")).insertOne({ _id: randomUUID(), userId: report.createdBy, title: "Report " + status.toLowerCase().replaceAll("_", " "), message: note || ("Your report \"" + report.title + "\" status changed to " + status.toLowerCase().replaceAll("_", " ") + "."), createdAt: changedAt, read: false });
	if (statusChanged) await recordAdminAction(req.user!.id, "REPORT_STATUS_CHANGED", "COMMUNITY_REPORT", String(req.params.id), report.title + ": " + canonicalStatus(report.status) + " → " + status + ".");
	return res.json(serializeReport((await reports.findOne({ _id: req.params.id }))!, req.user!.id));
}

export async function addReportComment(req: Request, res: Response) {
	const reports = await getCollection("CommunityReport");
	const report = await reports.findOne({ _id: req.params.id, deletedAt: { $exists: false }, isDeleted: { $ne: true } });
	if (!report || canonicalStatus(report.status) === "REJECTED") return res.status(404).json({ error: "Report not found." });
	const user = await (await getCollection("User")).findOne({ _id: req.user!.id }, { projection: { name: 1 } });
	const comment = { id: randomUUID(), userId: req.user!.id, authorName: user?.name ?? "SustainX member", message: String(req.body.message).trim(), createdAt: new Date() };
	await reports.updateOne({ _id: req.params.id }, [{ $set: { comments: { $concatArrays: [{ $ifNull: ["$comments", []] }, [comment]] } } }]);
	return res.status(201).json(comment);
}

export async function toggleReportUpvote(req: Request, res: Response) {
	const reports = await getCollection("CommunityReport");
	const report = await reports.findOne({ _id: req.params.id, deletedAt: { $exists: false }, isDeleted: { $ne: true }, status: { $ne: "REJECTED" } });
	if (!report) return res.status(404).json({ error: "Report not found." });
	const userId = req.user!.id;
	await reports.updateOne({ _id: report._id }, [{ $set: { upvotes: { $cond: [{ $in: [userId, { $ifNull: ["$upvotes", []] }] }, { $setDifference: [{ $ifNull: ["$upvotes", []] }, [userId]] }, { $setUnion: [{ $ifNull: ["$upvotes", []] }, [userId]] }] } } }]);
	const updated = await reports.findOne({ _id: report._id }, { projection: { upvotes: 1 } });
	const upvotes: string[] = Array.isArray(updated?.upvotes) ? updated.upvotes : [];
	return res.json({ upvotes: upvotes.length, upvoted: upvotes.includes(userId) });
}
