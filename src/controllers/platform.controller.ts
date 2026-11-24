import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { getCollection, toApiDocument } from "../config/db";
import { verifyActivity, rejectActivity } from "../services/impact.service";

export async function publicSummary(_req: Request, res: Response) {
  const [sdgs, challenges, projects, verified, locations] = await Promise.all([
    (await getCollection("Sdg")).countDocuments(),
    (await getCollection("Challenge")).countDocuments({ status: { $ne: "ARCHIVED" } }),
    (await getCollection("Project")).countDocuments({ status: { $ne: "ARCHIVED" } }),
    (await getCollection("Activity")).countDocuments({ status: "VERIFIED" }),
    (await getCollection("Activity")).distinct("location", { status: "VERIFIED" }),
  ]);
  res.json({ sdgs, challenges, projects, verifiedActivities: verified, locations: locations.filter(Boolean).length, modules: 3 });
}

export async function dashboard(req: Request, res: Response) {
  const userId = req.user!.id;
  const [user, activities, notifications, certificates, challenges, projects] = await Promise.all([
    (await getCollection("User")).findOne({ _id: userId }),
    (await getCollection("Activity")).find({ userId }).sort({ createdAt: -1 }).toArray(),
    (await getCollection("Notification")).find({ userId }).sort({ createdAt: -1 }).limit(8).toArray(),
    (await getCollection("Certificate")).countDocuments({ userId, status: { $ne: "REVOKED" } }),
    (await getCollection("Challenge")).countDocuments({ joinedUserIds: userId }),
    (await getCollection("Project")).countDocuments({ memberIds: userId }),
  ]);
  const verified = activities.filter((item) => item.status === "VERIFIED");
  const monthly = new Map<string, number>();
  const bySdg = new Map<number, number>();
  for (const item of verified) {
    const date = new Date(item.reviewedAt ?? item.createdAt ?? Date.now());
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly.set(key, (monthly.get(key) ?? 0) + 1);
    bySdg.set(item.sdgId, (bySdg.get(item.sdgId) ?? 0) + 1);
  }
  const monthKeys = Array.from({ length: 6 }, (_, offset) => {
    const date = new Date(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - (5 - offset));
    return { key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`, month: date.toLocaleString("en", { month: "short", timeZone: "UTC" }) };
  });
  const sdgs = await (await getCollection("Sdg")).find().toArray();
  const userData = user ? toApiDocument(user) : null;
  res.json({
    user: userData,
    stats: {
      totalActivities: activities.length,
      verifiedActivities: verified.length,
      totalPoints: Number(user?.impactPoints ?? 0),
      projects,
      challenges,
      certificates,
      sdgsImpacted: bySdg.size,
    },
    activities: activities.map(toApiDocument),
    notifications: notifications.map(toApiDocument),
    activityGrowth: monthKeys.map(({ key, month }) => ({ month, activities: monthly.get(key) ?? 0 })),
    sdgImpact: sdgs.filter((sdg) => bySdg.has(sdg._id)).map((sdg) => ({ name: `SDG ${sdg._id}`, value: bySdg.get(sdg._id) ?? 0 })),
  });
}

export async function adminOverview(_req: Request, res: Response) {
  const [users, activities, projects, reports, certificates, sdgs] = await Promise.all([
    (await getCollection("User")).find().toArray(),
    (await getCollection("Activity")).find().toArray(),
    (await getCollection("Project")).find().toArray(),
    (await getCollection("CommunityReport")).find().toArray(),
    (await getCollection("Certificate")).find({ status: { $ne: "REVOKED" } }).toArray(),
    (await getCollection("Sdg")).find().sort({ _id: 1 }).toArray(),
  ]);
  const verified = activities.filter((item) => item.status === "VERIFIED");
  const pending = activities.filter((item) => item.status === "PENDING");
  const monthKeys = Array.from({ length: 6 }, (_, offset) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - offset));
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, month: d.toLocaleString("en", { month: "short" }) };
  });
  const growth = monthKeys.map(({ key, month }) => {
    const inMonth = (rawDate: unknown) => {
      if (!rawDate) return false;
      const date = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
      return Number.isNaN(date.getTime()) ? false : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}` === key;
    };
    return { month, activities: activities.filter((item) => inMonth(item.createdAt)).length, users: users.filter((item) => inMonth(item.createdAt)).length };
  });
  const impactBySdg = new Map<number, number>();
  verified.forEach((item) => impactBySdg.set(item.sdgId, (impactBySdg.get(item.sdgId) ?? 0) + 1));
  const userIds = new Set(users.map((user) => user._id));
  const pendingItems = await (await getCollection("Activity")).aggregate([
    { $match: { status: "PENDING" } },
    { $lookup: { from: "User", localField: "userId", foreignField: "_id", as: "user" } },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    { $sort: { createdAt: -1 } }, { $limit: 8 },
  ]).toArray();
  res.json({
    stats: {
      users: users.length,
      totalActivities: activities.length,
      pendingActivities: pending.length,
      verifiedActivities: verified.length,
      rejectedActivities: activities.filter((item) => item.status === "REJECTED").length,
      totalPoints: users.reduce((sum, user) => sum + Number(user.impactPoints ?? 0), 0),
      certificates: certificates.length,
      projects: projects.length,
      participants: new Set(projects.flatMap((project) => Array.isArray(project.memberIds) ? project.memberIds : [])).size || userIds.size,
      reports: reports.length,
      reportsUnderReview: reports.filter((item) => ["UNDER_REVIEW", "IN_PROGRESS"].includes(item.status)).length,
      resolvedReports: reports.filter((item) => item.status === "RESOLVED").length,
    },
    activityGrowth: growth,
    sdgImpact: sdgs.map((sdg) => ({ name: `SDG ${sdg._id}`, value: impactBySdg.get(sdg._id) ?? 0 })),
    pending: pendingItems.map((item) => ({ ...toApiDocument(item), student: item.user?.name ?? "Unknown", email: item.user?.email ?? "", sdg: item.sdgId })),
  });
}

export async function adminActivities(_req: Request, res: Response) {
  const items = await (await getCollection("Activity")).aggregate([
    { $lookup: { from: "User", localField: "userId", foreignField: "_id", as: "user" } },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    { $sort: { createdAt: -1 } },
  ]).toArray();
  res.json(items.map((item) => ({ ...toApiDocument(item), student: item.user?.name ?? "Unknown", email: item.user?.email ?? "", sdg: item.sdgId, evidence: item.evidenceUrl ?? "", submitted: item.createdAt })));
}

export async function reviewActivity(req: Request, res: Response) {
  const id = String(req.params.id);
  const activity = req.body.status === "VERIFIED"
    ? await verifyActivity(id, req.body.reviewNote)
    : await rejectActivity(id, req.body.reviewNote);
  if (!activity) return res.status(404).json({ error: "Activity not found" });
  return res.json(activity);
}

export async function adminUsers(_req: Request, res: Response) {
  const users = await (await getCollection("User")).find().sort({ createdAt: -1 }).toArray();
  const counts = await (await getCollection("Activity")).aggregate([{ $group: { _id: "$userId", count: { $sum: 1 } } }]).toArray();
  const activityCount = new Map(counts.map((item) => [item._id, item.count]));
  res.json(users.map((user) => ({ ...toApiDocument(user), points: Number(user.impactPoints ?? 0), activities: activityCount.get(user._id) ?? 0, status: user.status ?? "ACTIVE" })));
}

export async function createUser(req: Request, res: Response) {
  const users = await getCollection("User");
  if (await users.findOne({ email: req.body.email })) return res.status(409).json({ error: "An account with this email already exists" });
  const user = { _id: randomUUID(), name: req.body.name, email: req.body.email.toLowerCase(), role: req.body.role, impactPoints: 0, createdAt: new Date(), status: "ACTIVE" };
  await users.insertOne(user);
  return res.status(201).json({ ...toApiDocument(user), points: 0, activities: 0 });
}

export async function myCertificates(req: Request, res: Response) {
  const items = await (await getCollection("Certificate")).find({ userId: req.user!.id }).sort({ issuedAt: -1 }).toArray();
  res.json(items.map(toApiDocument));
}

export async function verifyCertificate(req: Request, res: Response) {
  const certificate = await (await getCollection("Certificate")).findOne({ $or: [{ _id: req.params.id }, { certificateNumber: req.params.id }] });
  if (!certificate || certificate.status === "REVOKED") return res.status(404).json({ error: "Certificate not found or revoked" });
  const user = await (await getCollection("User")).findOne({ _id: certificate.userId }, { projection: { name: 1 } });
  return res.json({ ...toApiDocument(certificate), recipient: user?.name ?? "SustainX member", verified: true });
}
