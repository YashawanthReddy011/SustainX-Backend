import { Request, Response } from "express";
import { getCollection, toApiDocument } from "../config/db";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";
import { verifyActivity, rejectActivity } from "../services/impact.service";
import { getRecentAdminActions, recordAdminAction } from "../services/adminAudit.service";
import { activeChallengeFilter, publishedProjectFilter } from "../services/impactMetrics.service";

export async function publicSummary(_req: Request, res: Response) {
  const now = new Date();
  const projectFilter = publishedProjectFilter();
  const monthKeys = Array.from({ length: 6 }, (_, offset) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (5 - offset));
    return { key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`, month: date.toLocaleString("en", { month: "short", timeZone: "UTC" }) };
  });
  const firstMonth = monthKeys[0].key;
  const [sdgs, activeChallenges, impactProjects, verifiedActions, resolvedIssues, locationRows, activities, activityAnalytics, pointRows, participantRows, activitySdgs, environmentalSdgs, leaderboard] = await Promise.all([
    (await getCollection("Sdg")).countDocuments(),
    (await getCollection("Challenge")).countDocuments(activeChallengeFilter(now)),
    (await getCollection("Project")).countDocuments(projectFilter),
    (await getCollection("Activity")).countDocuments({ status: "VERIFIED", isDemo: { $ne: true } }),
    (await getCollection("CommunityReport")).countDocuments({ status: "RESOLVED", deletedAt: { $exists: false }, isDeleted: { $ne: true }, isDemo: { $ne: true } }),
    (await getCollection("Activity")).aggregate<any>([{ $match: { status: "VERIFIED", isDemo: { $ne: true }, location: { $nin: [null, ""] } } }, { $group: { _id: "$location" } }, { $count: "count" }]).toArray(),
    (await getCollection("Activity")).find({ status: "VERIFIED", isDemo: { $ne: true } }).sort({ reviewedAt: -1, createdAt: -1 }).limit(6).toArray(),
    (await getCollection("Activity")).aggregate<any>([
      { $match: { status: "VERIFIED", isDemo: { $ne: true } } },
      { $facet: {
        sdgs: [{ $match: { sdgId: { $type: "number" } } }, { $group: { _id: "$sdgId", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }],
        monthly: [{ $group: { _id: { $dateToString: { format: "%Y-%m", date: { $ifNull: ["$reviewedAt", "$createdAt"] }, timezone: "UTC", onNull: "unknown" } }, count: { $sum: 1 } } }, { $match: { _id: { $gte: firstMonth } } }],
      } },
    ]).toArray(),
    (await getCollection("Activity")).aggregate<any>([
      { $match: { status: "VERIFIED", isDemo: { $ne: true } } },
      { $group: { _id: null, points: { $sum: { $ifNull: ["$points", 0] } } } },
    ]).toArray(),
    (await getCollection("Project")).aggregate<any>([
      { $match: projectFilter },
      { $unwind: "$memberIds" },
      { $group: { _id: "$memberIds" } },
      { $lookup: {
        from: "User",
        let: { userId: "$_id" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$_id", "$$userId"] }, { $eq: ["$status", "ACTIVE"] }, { $eq: ["$emailVerified", true] }, { $ne: ["$isDemo", true] }] } } },
          { $project: { _id: 1 } },
        ],
        as: "registeredUser",
      } },
      { $match: { $expr: { $gt: [{ $size: "$registeredUser" }, 0] } } },
      { $count: "count" },
    ]).toArray(),
    (await getCollection("Activity")).distinct("sdgId", { status: "VERIFIED", isDemo: { $ne: true } }),
    (await getCollection("environmentalActivities")).distinct("sdgNumbers", { isDemo: { $ne: true } }),
    (await getCollection("Activity")).aggregate<any>([
      { $match: { status: "VERIFIED", isDemo: { $ne: true } } },
      { $group: { _id: "$userId", points: { $sum: { $ifNull: ["$points", 0] } } } },
      { $match: { points: { $gt: 0 } } },
      { $lookup: {
        from: "User",
        let: { userId: "$_id" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$_id", "$$userId"] }, { $eq: ["$status", "ACTIVE"] }, { $eq: ["$emailVerified", true] }, { $ne: ["$isDemo", true] }] } } },
          { $project: { name: 1 } },
        ],
        as: "user",
      } },
      { $unwind: "$user" },
      { $sort: { points: -1, _id: 1 } },
      { $limit: 5 },
    ]).toArray(),
  ]);
  const recentProjects = await (await getCollection("Project")).find(projectFilter).sort({ createdAt: -1 }).limit(4).toArray();
  const topSdgs = (activityAnalytics[0]?.sdgs ?? []).map((row: any) => ({ number: Number(row._id), count: Number(row.count) }));
  const monthlyMap = new Map<string, number>((activityAnalytics[0]?.monthly ?? []).map((row: any) => [String(row._id), Number(row.count)] as [string, number]));
  const sdgsCovered = new Set([...activitySdgs, ...environmentalSdgs].map(Number).filter((id) => Number.isInteger(id) && id >= 1 && id <= 17)).size;
  res.json({
    sdgs,
    challenges: activeChallenges,
    projects: impactProjects,
    verifiedActivities: verifiedActions,
    sdgsCovered,
    activeChallenges,
    verifiedActions,
    impactProjects,
    resolvedIssues,
    participants: Number(participantRows[0]?.count ?? 0),
    impactPoints: Number(pointRows[0]?.points ?? 0),
    locations: Number(locationRows[0]?.count ?? 0),
    modules: 3,
    recentActivities: activities.map(toApiDocument),
    recentProjects: recentProjects.map(toApiDocument),
    topSdgs,
    monthlyImpact: monthKeys.map(({ key, month }) => ({ month, activities: monthlyMap.get(key) ?? 0 })),
    leaderboard: leaderboard.map((entry: any, index: number) => ({
      id: String(entry._id),
      name: entry.user.name,
      points: Number(entry.points ?? 0),
      rank: index + 1,
    })),
  });
}

export async function dashboard(req: Request, res: Response) {
  const userId = req.user!.id;
  const [user, activities, notifications, certificates, projects, joinedChallenges, userReports, environmentalRecords, memberships] = await Promise.all([
    (await getCollection("User")).findOne({ _id: userId }, { projection: { name: 1, email: 1, role: 1, impactPoints: 1, emailVerified: 1 } }),
    (await getCollection("Activity")).find({ userId }).sort({ createdAt: -1 }).toArray(),
    (await getCollection("Notification")).find({ userId }).sort({ createdAt: -1 }).limit(8).toArray(),
    (await getCollection("Certificate")).countDocuments({ userId, status: { $ne: "REVOKED" } }),
    (await getCollection("Project")).find({ $or: [{ ownerId: userId }, { memberIds: userId }] }).sort({ updatedAt: -1, createdAt: -1 }).toArray(),
    (await getCollection("Challenge")).find({ joinedUserIds: userId }).sort({ createdAt: -1 }).toArray(),
    (await getCollection("CommunityReport")).find({ createdBy: userId }).sort({ createdAt: -1 }).toArray(),
    (await getCollection("environmentalActivities")).find({ userId }).sort({ verifiedAt: -1 }).toArray(),
    (await getCollection("ConversationMember")).find({ userId }, { projection: { conversationId: 1 } }).toArray(),
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
  const environmentalTotals = { trees: 0, litres: 0, wasteKg: 0, speciesObservations: 0 };
  const environmentalMonthly = new Map<string, number>();
  for (const item of environmentalRecords) {
    const quantity = Number(item.quantity ?? 0);
    if (item.type === "TREE_PLANTATION") environmentalTotals.trees += quantity;
    else if (item.type === "WATER_CONSERVATION") environmentalTotals.litres += quantity;
    else if (item.type === "WASTE_REDUCTION") environmentalTotals.wasteKg += quantity;
    else if (item.type === "BIODIVERSITY") environmentalTotals.speciesObservations += quantity;
    const date = new Date(item.verifiedAt ?? item.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    environmentalMonthly.set(key, (environmentalMonthly.get(key) ?? 0) + 1);
  }
  const reportStatuses = ["REPORTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED"].map((status) => ({
    status,
    count: userReports.filter((report) => report.status === status).length,
  }));
  const reportMonthly = new Map<string, number>();
  for (const report of userReports) {
    const date = new Date(report.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    reportMonthly.set(key, (reportMonthly.get(key) ?? 0) + 1);
  }
  const discussionConversationIds = memberships.map((item) => String(item.conversationId));
  const discussionGroups = discussionConversationIds.length
    ? await (await getCollection("Conversation")).countDocuments({ _id: { $in: discussionConversationIds }, type: { $in: ["GROUP", "COMMUNITY"] } })
    : 0;
  const [sdgs, leaderboardUsers, usersAbove] = await Promise.all([
    (await getCollection("Sdg")).find().toArray(),
    (await getCollection("User")).find({ status: "ACTIVE", emailVerified: true }, { projection: { name: 1, impactPoints: 1 } }).sort({ impactPoints: -1, createdAt: 1 }).limit(5).toArray(),
    (await getCollection("User")).countDocuments({ status: "ACTIVE", emailVerified: true, impactPoints: { $gt: Number(user?.impactPoints ?? 0) } }),
  ]);
  const userData = user ? toApiDocument(user) : null;
  res.json({
    user: userData,
    stats: {
      totalActivities: activities.length,
      verifiedActivities: verified.length,
      totalPoints: Number(user?.impactPoints ?? 0),
      projects: projects.length,
      challenges: joinedChallenges.length,
      certificates,
      sdgsImpacted: bySdg.size,
      environmentalSubmissions: environmentalRecords.length,
      reportsSubmitted: userReports.length,
      reportsResolved: userReports.filter((report) => report.status === "RESOLVED").length,
      discussionGroups,
    },
    activities: activities.map(toApiDocument),
    notifications: notifications.map(toApiDocument),
    activityGrowth: monthKeys.map(({ key, month }) => ({ month, activities: monthly.get(key) ?? 0 })),
    sdgImpact: sdgs.filter((sdg) => bySdg.has(sdg._id)).map((sdg) => ({ name: `SDG ${sdg._id}`, value: bySdg.get(sdg._id) ?? 0 })),
    joinedChallenges: joinedChallenges.slice(0, 12).map((challenge) => ({
      id: String(challenge._id), title: challenge.title, status: challenge.status ?? "ACTIVE",
      points: Number(challenge.points ?? 0), participants: Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds.length : 0,
    })),
    projectProgress: projects.slice(0, 12).map((project) => {
      const milestones = Array.isArray(project.milestones) ? project.milestones : [];
      return {
        id: String(project._id), title: project.title, status: project.status ?? "ACTIVE",
        progress: Number(project.progress ?? 0), milestones: milestones.length,
        completedMilestones: milestones.filter((milestone: { status?: string }) => milestone.status === "COMPLETED").length,
      };
    }),
    environmentalImpact: {
      ...environmentalTotals,
      verifiedSubmissions: environmentalRecords.length,
      monthly: monthKeys.map(({ key, month }) => ({ month, verifiedSubmissions: environmentalMonthly.get(key) ?? 0 })),
    },
    communityAnalytics: {
      reportsByStatus: reportStatuses,
      monthlyReports: monthKeys.map(({ key, month }) => ({ month, reports: reportMonthly.get(key) ?? 0 })),
      recentReports: userReports.slice(0, 6).map((report) => ({ id: String(report._id), title: report.title, status: report.status, createdAt: report.createdAt })),
    },
    leaderboard: {
      userRank: usersAbove + 1,
      topUsers: leaderboardUsers.map((entry, index) => ({ id: String(entry._id), name: entry.name, points: Number(entry.impactPoints ?? 0), rank: index + 1 })),
    },
  });
}

export async function adminOverview(_req: Request, res: Response) {
  const now = new Date();
  const monthKeys = Array.from({ length: 6 }, (_, offset) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - offset), 1));
    return {
      key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
      month: date.toLocaleString("en", { month: "short", timeZone: "UTC" }),
    };
  });
  const firstMonth = monthKeys[0].key;

  const [userSummaryRows, activitySummaryRows, projectSummaryRows, reportSummaryRows, certificateCount, sdgs, environmentalSummaryRows, recentAuditLogs, pendingItems] = await Promise.all([
    (await getCollection("User")).aggregate<any>([
      { $match: { isDemo: { $ne: true } } },
      { $facet: {
        totals: [{ $group: { _id: null, users: { $sum: 1 }, activeUsers: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "ACTIVE"] }, { $eq: ["$emailVerified", true] }] }, 1, 0] } } } }],
        growth: [{ $match: { createdAt: { $type: "date" } } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 } } }, { $match: { _id: { $gte: firstMonth } } }],
      } },
    ]).toArray(),
    (await getCollection("Activity")).aggregate<any>([
      { $match: { isDemo: { $ne: true } } },
      { $facet: {
        totals: [{ $group: { _id: null, total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } }, verified: { $sum: { $cond: [{ $eq: ["$status", "VERIFIED"] }, 1, 0] } }, rejected: { $sum: { $cond: [{ $eq: ["$status", "REJECTED"] }, 1, 0] } }, points: { $sum: { $cond: [{ $eq: ["$status", "VERIFIED"] }, { $ifNull: ["$points", 0] }, 0] } } } }],
        growth: [{ $match: { createdAt: { $type: "date" } } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 } } }, { $match: { _id: { $gte: firstMonth } } }],
        verifiedGrowth: [{ $match: { status: "VERIFIED" } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: { $ifNull: ["$reviewedAt", "$createdAt"] }, timezone: "UTC", onNull: "unknown" } }, count: { $sum: 1 } } }, { $match: { _id: { $gte: firstMonth } } }],
        sdgs: [{ $match: { status: "VERIFIED", sdgId: { $type: "number" } } }, { $group: { _id: "$sdgId", count: { $sum: 1 } } }],
      } },
    ]).toArray(),
    (await getCollection("Project")).aggregate<any>([
      { $facet: {
        total: [{ $match: publishedProjectFilter() }, { $count: "count" }],
        statuses: [{ $match: { isDemo: { $ne: true }, deletedAt: { $exists: false }, isDeleted: { $ne: true } } }, { $group: { _id: { $ifNull: ["$status", "ACTIVE"] }, count: { $sum: 1 } } }],
        participants: [
          { $match: publishedProjectFilter() },
          { $unwind: "$memberIds" },
          { $group: { _id: "$memberIds" } },
          { $lookup: {
            from: "User",
            let: { userId: "$_id" },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ["$_id", "$$userId"] }, { $eq: ["$status", "ACTIVE"] }, { $eq: ["$emailVerified", true] }, { $ne: ["$isDemo", true] }] } } },
              { $project: { _id: 1 } },
            ],
            as: "registeredUser",
          } },
          { $match: { $expr: { $gt: [{ $size: "$registeredUser" }, 0] } } },
          { $count: "count" },
        ],
      } },
    ]).toArray(),
    (await getCollection("CommunityReport")).aggregate<any>([
      { $match: { isDemo: { $ne: true }, deletedAt: { $exists: false }, isDeleted: { $ne: true } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray(),
    (await getCollection("Certificate")).countDocuments({ status: { $ne: "REVOKED" } }),
    (await getCollection("Sdg")).find().sort({ _id: 1 }).toArray(),
    (await getCollection("environmentalActivities")).aggregate<any>([
      { $match: { isDemo: { $ne: true } } },
      { $facet: {
        types: [{ $group: { _id: "$type", quantity: { $sum: { $ifNull: ["$quantity", 0] } }, count: { $sum: 1 } } }],
        sdgs: [{ $unwind: "$sdgNumbers" }, { $group: { _id: "$sdgNumbers" } }],
      } },
    ]).toArray(),
    getRecentAdminActions(),
    (await getCollection("Activity")).aggregate<any>([
      { $match: { status: "PENDING", isDemo: { $ne: true } } },
      { $lookup: { from: "User", let: { userId: "$userId" }, pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$userId"] } } }, { $project: { name: 1, email: 1 } }], as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      { $sort: { createdAt: -1 } }, { $limit: 8 },
    ]).toArray(),
  ]);

  const users = userSummaryRows[0]?.totals[0] ?? { users: 0, activeUsers: 0 };
  const activity = activitySummaryRows[0] ?? { totals: [], growth: [], verifiedGrowth: [], sdgs: [] };
  const activityTotals = activity.totals[0] ?? { total: 0, pending: 0, verified: 0, rejected: 0 };
  const projectSummary = projectSummaryRows[0] ?? { total: [], statuses: [], participants: [] };
  const reportCounts = new Map(reportSummaryRows.map((row) => [String(row._id), Number(row.count)]));
  const environmental = environmentalSummaryRows[0] ?? { types: [], sdgs: [] };
  const activityGrowth = new Map<string, number>(activity.growth.map((row: any) => [String(row._id), Number(row.count)] as [string, number]));
  const verifiedGrowth = new Map<string, number>(activity.verifiedGrowth.map((row: any) => [String(row._id), Number(row.count)] as [string, number]));
  const userGrowth = new Map<string, number>((userSummaryRows[0]?.growth ?? []).map((row: any) => [String(row._id), Number(row.count)] as [string, number]));
  const sdgCounts = new Map<number, number>(activity.sdgs.map((row: any) => [Number(row._id), Number(row.count)] as [number, number]));
  const projectCounts = new Map<string, number>(projectSummary.statuses.map((row: any) => [String(row._id), Number(row.count)] as [string, number]));
  const projectStatuses = ["ACTIVE", "COMPLETED", "ARCHIVED"].map((status) => ({ status, count: projectCounts.get(status) ?? 0 }));
  const reportStatuses = ["REPORTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED"].map((status) => ({ status, count: reportCounts.get(status) ?? 0 }));
  const typeTotals = new Map<string, { quantity: number; count: number }>(environmental.types.map((row: any) => [String(row._id), { quantity: Number(row.quantity), count: Number(row.count) }] as [string, { quantity: number; count: number }]));
  const getEcoTotal = (type: string) => typeTotals.get(type)?.quantity ?? 0;
  const ecoSdgNumbers = environmental.sdgs.map((row: any) => Number(row._id));
  const sdgsCovered = new Set([...activity.sdgs.map((row: any) => Number(row._id)), ...ecoSdgNumbers].filter((id: number) => Number.isInteger(id) && id >= 1 && id <= 17)).size;
  const projectTotal = Number(projectSummary.total[0]?.count ?? 0);
  const environmentalSubmissions = environmental.types.reduce((sum: number, row: any) => sum + Number(row.count), 0);

  res.json({
    stats: {
      users: Number(users.users), activeUsers: Number(users.activeUsers), totalActivities: Number(activityTotals.total),
      pendingActivities: Number(activityTotals.pending), verifiedActivities: Number(activityTotals.verified), rejectedActivities: Number(activityTotals.rejected),
      totalPoints: Number(activityTotals.points), certificates: certificateCount, sdgsCovered, projects: projectTotal,
      participants: Number(projectSummary.participants[0]?.count ?? 0),
      reports: Array.from(reportCounts.values()).reduce((sum, count) => sum + count, 0), pendingReports: reportCounts.get("REPORTED") ?? 0,
      reportsUnderReview: (reportCounts.get("UNDER_REVIEW") ?? 0) + (reportCounts.get("IN_PROGRESS") ?? 0),
      resolvedReports: reportCounts.get("RESOLVED") ?? 0, environmentalSubmissions,
    },
    activityGrowth: monthKeys.map(({ key, month }) => ({ month, activities: activityGrowth.get(key) ?? 0, verifiedActivities: verifiedGrowth.get(key) ?? 0, users: userGrowth.get(key) ?? 0 })),
    sdgImpact: sdgs.map((sdg) => ({ name: `SDG ${sdg._id}`, value: sdgCounts.get(Number(sdg._id)) ?? 0 })),
    projectStatuses,
    reportStatuses,
    environmentalImpact: {
      trees: getEcoTotal("TREE_PLANTATION"), litres: getEcoTotal("WATER_CONSERVATION"),
      wasteKg: getEcoTotal("WASTE_REDUCTION"), speciesObservations: getEcoTotal("BIODIVERSITY"), verifiedSubmissions: environmentalSubmissions,
    },
    recentAuditLogs,
    pending: pendingItems.map((item) => ({ ...toApiDocument(item), student: item.user?.name ?? "Unknown", email: item.user?.email ?? "", sdg: item.sdgId })),
  });
}

export async function adminActivities(req: Request, res: Response) {
  const collection = await getCollection("Activity");
  const pagination = getApiPagination(req);
  const pipeline: Record<string, unknown>[] = [{ $sort: { createdAt: -1 } }];
  if (pagination.enabled) pipeline.push({ $skip: pagination.skip }, { $limit: pagination.limit });
  pipeline.push(
    { $lookup: { from: "User", let: { userId: "$userId" }, pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$userId"] } } }, { $project: { name: 1, email: 1 } }], as: "user" } },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
  );
  const items = await collection.aggregate(pipeline).toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments());
  res.json(items.map((item) => ({ ...toApiDocument(item), student: item.user?.name ?? "Unknown", email: item.user?.email ?? "", sdg: item.sdgId, evidence: item.evidenceUrl ?? "", submitted: item.createdAt })));
}

export async function reviewActivity(req: Request, res: Response) {
  const id = String(req.params.id);
  const activity = req.body.status === "VERIFIED"
    ? await verifyActivity(id, req.body.reviewNote)
    : await rejectActivity(id, req.body.reviewNote);
  if (!activity) return res.status(404).json({ error: "Activity not found" });
  await recordAdminAction(req.user!.id, `ACTIVITY_${req.body.status}`, "ACTIVITY", id, `${activity.title} was ${req.body.status.toLowerCase()}.`);
  return res.json(activity);
}

export async function adminUsers(req: Request, res: Response) {
  const usersCollection = await getCollection("User");
  const pagination = getApiPagination(req);
  const query = usersCollection.find({}, { projection: { name: 1, email: 1, role: 1, impactPoints: 1, status: 1, createdAt: 1, emailVerified: 1 } }).sort({ createdAt: -1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const users = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await usersCollection.countDocuments());
  const pageIds = users.map((user) => user._id);
  const counts = pageIds.length
    ? await (await getCollection("Activity")).aggregate([{ $match: { userId: { $in: pageIds } } }, { $group: { _id: "$userId", count: { $sum: 1 } } }]).toArray()
    : [];
  const activityCount = new Map(counts.map((item) => [item._id, item.count]));
  res.json(users.map((user) => ({ ...toApiDocument(user), points: Number(user.impactPoints ?? 0), activities: activityCount.get(user._id) ?? 0, status: user.emailVerified === true ? (user.status ?? "ACTIVE") : "UNVERIFIED" })));
}

export async function myCertificates(req: Request, res: Response) {
  const collection = await getCollection("Certificate");
  const filter = { userId: req.user!.id };
  const pagination = getApiPagination(req);
  const query = collection.find(filter).sort({ issuedAt: -1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const items = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
  res.json(items.map(toApiDocument));
}

export async function verifyCertificate(req: Request, res: Response) {
  const certificate = await (await getCollection("Certificate")).findOne({ $or: [{ _id: req.params.id }, { certificateNumber: req.params.id }] });
  if (!certificate || certificate.status === "REVOKED") return res.status(404).json({ error: "Certificate not found or revoked" });
  const user = await (await getCollection("User")).findOne({ _id: certificate.userId }, { projection: { name: 1 } });
  return res.json({ ...toApiDocument(certificate), recipient: user?.name ?? "SustainX member", verified: true });
}
