import { randomUUID } from "node:crypto";
import { getCollection } from "../config/db";

export async function ensureAdminAuditIndex() {
	await (await getCollection("AdminAuditLog")).createIndex({ createdAt: -1 }, { name: "admin_audit_recent" });
}

export async function recordAdminAction(actorId: string, action: string, targetType: string, targetId: string, details: string) {
	try {
		await (await getCollection("AdminAuditLog")).insertOne({
			_id: randomUUID(), actorId, action, targetType, targetId,
			details: details.slice(0, 240), createdAt: new Date(),
		});
	} catch (error) {
		console.error("Unable to record administrator audit action.", error);
	}
}

export async function getRecentAdminActions(limit = 12) {
	const logs = await (await getCollection("AdminAuditLog")).find().sort({ createdAt: -1 }).limit(limit).toArray();
	const actorIds = [...new Set(logs.map((item) => String(item.actorId)))];
	const users = actorIds.length
		? await (await getCollection("User")).find({ _id: { $in: actorIds } }, { projection: { name: 1 } }).toArray()
		: [];
	const names = new Map(users.map((user) => [String(user._id), String(user.name ?? "Administrator")]));
	return logs.map((item) => ({
		id: String(item._id), actor: names.get(String(item.actorId)) ?? "Administrator",
		action: String(item.action), targetType: String(item.targetType), targetId: String(item.targetId),
		details: String(item.details ?? ""), createdAt: item.createdAt,
	}));
}
