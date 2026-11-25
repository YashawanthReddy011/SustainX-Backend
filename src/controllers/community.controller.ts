import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { getCollection, toApiDocument } from "../config/db";
import { recordAdminAction } from "../services/adminAudit.service";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";

export async function listChallenges(req: Request, res: Response) {
  const filter: Record<string, unknown> = { status: { $ne: "ARCHIVED" } };
  if (process.env.NODE_ENV === "production") filter.isDemo = { $ne: true };
  if (typeof req.query.status === "string" && req.query.status !== "ALL") {
    if (!["ACTIVE", "COMPLETED"].includes(req.query.status)) return res.status(400).json({ error: "status must be ACTIVE, COMPLETED, or ALL." });
    filter.status = req.query.status;
  }
  if (typeof req.query.sdgId === "string") {
    const sdgId = Number(req.query.sdgId);
    if (!Number.isInteger(sdgId) || sdgId < 1 || sdgId > 17) return res.status(400).json({ error: "sdgId must be an integer between 1 and 17." });
    filter.sdgId = sdgId;
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ title: { $regex: escaped, $options: "i" } }, { description: { $regex: escaped, $options: "i" } }];
  }
  const collection = await getCollection("Challenge");
  const pagination = getApiPagination(req);
  const query = collection.find(filter).sort({ createdAt: -1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const items = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
  res.json(items.map((item) => {
    const joinedUserIds = Array.isArray(item.joinedUserIds) ? [...new Set(item.joinedUserIds.filter((id: unknown) => typeof id === "string"))] : [];
    const { joinedUserIds: _private, ...fields } = item;
    return { ...toApiDocument(fields), participants: joinedUserIds.length, joined: Boolean(req.user && joinedUserIds.includes(req.user.id)) };
  }));
}

export async function getChallenge(req: Request, res: Response) {
  const challenge = await (await getCollection("Challenge")).findOne({ _id: req.params.id });
  if (!challenge || challenge.status === "ARCHIVED" || (process.env.NODE_ENV === "production" && challenge.isDemo === true)) return res.status(404).json({ error: "Challenge not found." });
  const joinedUserIds = Array.isArray(challenge.joinedUserIds) ? [...new Set(challenge.joinedUserIds.filter((id: unknown) => typeof id === "string"))] : [];
  const { joinedUserIds: _private, ...fields } = challenge;
  return res.json({ ...toApiDocument(fields), participants: joinedUserIds.length, joined: Boolean(req.user && joinedUserIds.includes(req.user.id)) });
}

export async function joinChallenge(req: Request, res: Response) {
  const challenges = await getCollection("Challenge");
  const id = req.params.id;
  const challenge = await challenges.findOne({ _id: id });
  if (!challenge || (process.env.NODE_ENV === "production" && challenge.isDemo === true)) return res.status(404).json({ error: "Challenge not found" });
  await challenges.updateOne({ _id: id }, [
    { $set: { joinedUserIds: { $setUnion: [{ $ifNull: ["$joinedUserIds", []] }, [req.user!.id]] } } },
    { $set: { participants: { $size: "$joinedUserIds" } } },
  ]);
  const updated = await challenges.findOne({ _id: id }, { projection: { joinedUserIds: 1 } });
  return res.json({ id, joined: true, participants: Array.isArray(updated?.joinedUserIds) ? updated.joinedUserIds.length : 0 });
}

export async function listProjects(req: Request, res: Response) {
  const filter: Record<string, unknown> = { status: { $ne: "ARCHIVED" } };
  if (process.env.NODE_ENV === "production") filter.isDemo = { $ne: true };
  if (typeof req.query.status === "string" && req.query.status !== "ALL") {
    if (!["ACTIVE", "COMPLETED"].includes(req.query.status)) return res.status(400).json({ error: "status must be ACTIVE, COMPLETED, or ALL." });
    filter.status = req.query.status;
  }
  if (typeof req.query.sdgId === "string") {
    const sdgId = Number(req.query.sdgId);
    if (!Number.isInteger(sdgId) || sdgId < 1 || sdgId > 17) return res.status(400).json({ error: "sdgId must be an integer between 1 and 17." });
    filter.$or = [{ sdgId }, { sdgNumbers: sdgId }];
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$and = [...(Array.isArray(filter.$or) ? [{ $or: filter.$or }] : []), { $or: [{ title: { $regex: escaped, $options: "i" } }, { description: { $regex: escaped, $options: "i" } }] }];
    delete filter.$or;
  }
  const collection = await getCollection("Project");
  const pagination = getApiPagination(req);
  const query = collection.find(filter).sort({ createdAt: -1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const items = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
  res.json(items.map((item) => {
    const memberIds = Array.isArray(item.memberIds) ? [...new Set(item.memberIds.filter((id: unknown) => typeof id === "string"))] : [];
    const { memberIds: _private, ...fields } = item;
    return { ...toApiDocument(fields), members: memberIds.length, joined: Boolean(req.user && memberIds.includes(req.user.id)) };
  }));
}

export async function createProject(req: Request, res: Response) {
  const owner = await (await getCollection("User")).findOne({ _id: req.user!.id });
  const sdgNumbers = req.body.sdgNumbers?.length ? [...new Set(req.body.sdgNumbers)] : [req.body.sdgId ?? 1];
  const project = {
    _id: randomUUID(),
    title: req.body.title,
    description: req.body.description,
    sdgId: sdgNumbers[0],
    sdgNumbers,
    location: req.body.location ?? "",
    ...(req.body.imageUrl ? { imageUrl: req.body.imageUrl } : {}),
    ownerId: req.user!.id,
    ownerName: owner?.name ?? "SustainX member",
    memberIds: [req.user!.id],
    members: 1,
    progress: 0,
    milestones: [],
    discussions: [],
    status: "ACTIVE",
    createdAt: new Date(),
  };
  await (await getCollection("Project")).insertOne(project);
  return res.status(201).json(toApiDocument(project));
}

export async function joinProject(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const id = req.params.id;
  const project = await projects.findOne({ _id: id });
  if (!project || (process.env.NODE_ENV === "production" && project.isDemo === true)) return res.status(404).json({ error: "Project not found" });
  await projects.updateOne({ _id: id }, [
    { $set: { memberIds: { $setUnion: [{ $ifNull: ["$memberIds", []] }, [req.user!.id]] } } },
    { $set: { members: { $size: "$memberIds" } } },
  ]);
  const updated = await projects.findOne({ _id: id }, { projection: { memberIds: 1 } });
  return res.json({ id, joined: true, members: Array.isArray(updated?.memberIds) ? updated.memberIds.length : 0 });
}

export async function getProject(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project || (process.env.NODE_ENV === "production" && project.isDemo === true)) return res.status(404).json({ error: "Project not found" });

  const users = await getCollection("User");
  const memberIds = Array.isArray(project.memberIds) ? [...new Set(project.memberIds.filter((id: unknown) => typeof id === "string"))] : [];
  const members = await users.find({ _id: { $in: memberIds } }).toArray();
  const activities = await (await getCollection("Activity")).find({ projectId: req.params.id }).sort({ createdAt: -1 }).toArray();
  const owner = await users.findOne({ _id: project.ownerId });

  res.json({
    ...toApiDocument(project),
    sdgNumbers: Array.isArray(project.sdgNumbers) ? project.sdgNumbers : [project.sdgId].filter(Boolean),
    members: memberIds.length,
    joined: Boolean(req.user && memberIds.includes(req.user.id)),
    ownerName: owner?.name ?? project.ownerName ?? "SustainX member",
    team: members.map((member) => ({ id: String(member._id), name: member.name, email: member.email, role: member.role })),
    milestones: Array.isArray(project.milestones) ? project.milestones : [],
    discussions: Array.isArray(project.discussions) ? project.discussions : [],
    activities: activities.map(toApiDocument),
  });
}

export async function deleteProject(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.ownerId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Only the project owner or an administrator can delete this project" });
  await projects.deleteOne({ _id: req.params.id });
  res.status(204).send();
}

export async function inviteProjectMember(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.ownerId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Only the project owner can invite participants" });
  const invited = await (await getCollection("User")).findOne({ email: req.body.email.toLowerCase() });
  if (!invited) return res.status(404).json({ error: "No SustainX user found with that email" });
  await projects.updateOne({ _id: req.params.id }, [
    { $set: { memberIds: { $setUnion: [{ $ifNull: ["$memberIds", []] }, [String(invited._id)]] } } },
    { $set: { members: { $size: "$memberIds" } } },
  ]);
  res.json({ invited: { id: String(invited._id), name: invited.name, email: invited.email } });
}

export async function removeProjectMember(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.ownerId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Only the project owner can manage team members" });
  if (req.params.memberId === project.ownerId) return res.status(400).json({ error: "The project owner cannot be removed" });
  await projects.updateOne({ _id: req.params.id }, [
    { $set: { memberIds: { $filter: { input: { $ifNull: ["$memberIds", []] }, as: "memberId", cond: { $ne: ["$$memberId", req.params.memberId] } } } } },
    { $set: { members: { $size: "$memberIds" } } },
  ]);
  res.json({ removed: req.params.memberId });
}

export async function addProjectMilestone(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.ownerId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Only the project owner can manage milestones" });
  const milestone = { id: randomUUID(), title: req.body.title, dueDate: req.body.dueDate ?? null, status: req.body.status ?? "PENDING", createdAt: new Date() };
  await projects.updateOne({ _id: req.params.id }, { $set: { milestones: [...(Array.isArray(project.milestones) ? project.milestones : []), milestone] } });
  res.status(201).json(milestone);
}

export async function updateProjectMilestone(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.ownerId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Only the project owner can manage milestones" });
  const milestones = Array.isArray(project.milestones) ? project.milestones : [];
  const update = milestones.find((item: { id: string }) => item.id === req.params.milestoneId);
  if (!update) return res.status(404).json({ error: "Milestone not found" });
  const next = milestones.map((item: { id: string }) => item.id === req.params.milestoneId ? { ...item, ...req.body, ...(req.body.dueDate ? { dueDate: req.body.dueDate } : {}) } : item);
  await projects.updateOne({ _id: req.params.id }, { $set: { milestones: next } });
  res.json(next.find((item: { id: string }) => item.id === req.params.milestoneId));
}

export async function addProjectDiscussion(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project) return res.status(404).json({ error: "Project not found" });
  const memberIds = Array.isArray(project.memberIds) ? [...new Set(project.memberIds.filter((id: unknown) => typeof id === "string"))] : [];
  if (project.ownerId !== req.user!.id && !memberIds.includes(req.user!.id)) return res.status(403).json({ error: "Join this project to participate in discussions" });
  const user = await (await getCollection("User")).findOne({ _id: req.user!.id });
  const discussion = { id: randomUUID(), userId: req.user!.id, authorName: user?.name ?? "SustainX member", message: req.body.message, createdAt: new Date() };
  await projects.updateOne({ _id: req.params.id }, { $set: { discussions: [...(Array.isArray(project.discussions) ? project.discussions : []), discussion] } });
  res.status(201).json(discussion);
}

export async function updateProject(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const project = await projects.findOne({ _id: req.params.id });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.ownerId !== req.user!.id && req.user!.role !== "ADMIN") return res.status(403).json({ error: "Only the project owner or an administrator can edit this project" });
  const sdgNumbers = req.body.sdgNumbers?.length ? [...new Set(req.body.sdgNumbers)] : req.body.sdgId ? [req.body.sdgId] : undefined;
  const $set = {
    ...(req.body.title ? { title: req.body.title } : {}),
    ...(req.body.description ? { description: req.body.description } : {}),
    ...(req.body.location !== undefined ? { location: req.body.location } : {}),
    ...(req.body.imageUrl !== undefined ? { imageUrl: req.body.imageUrl } : {}),
    ...(req.body.status ? { status: req.body.status } : {}),
    ...(typeof req.body.progress === "number" ? { progress: req.body.progress } : {}),
    ...(sdgNumbers ? { sdgNumbers, sdgId: sdgNumbers[0] } : {}),
  };
  const result = await projects.updateOne({ _id: req.params.id }, { $set });
  if (!result.matchedCount) return res.status(404).json({ error: "Project not found" });
  if (req.user!.role === "ADMIN") await recordAdminAction(req.user!.id, "PROJECT_UPDATED", "PROJECT", String(req.params.id), `Updated ${project.title}.`);
  return res.json(toApiDocument((await projects.findOne({ _id: req.params.id }))!));
}

export async function listReports(req: Request, res: Response) {
  const filter: Record<string, unknown> = {};
  if (process.env.NODE_ENV === "production") filter.isDemo = { $ne: true };
  if (typeof req.query.status === "string" && req.query.status !== "ALL") {
    if (!["REPORTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED"].includes(req.query.status)) return res.status(400).json({ error: "status is not a supported report status." });
    filter.status = req.query.status;
  }
  if (typeof req.query.category === "string" && req.query.category !== "ALL") {
    if (req.query.category.length > 80) return res.status(400).json({ error: "category must be 80 characters or fewer." });
    filter.category = req.query.category;
  }
  if (typeof req.query.location === "string" && req.query.location.trim()) {
    if (req.query.location.length > 180) return res.status(400).json({ error: "location must be 180 characters or fewer." });
    filter.location = { $regex: req.query.location.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }
  if (typeof req.query.search === "string") {
    const search = req.query.search.trim();
    if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
    if (search) filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }
  const collection = await getCollection("CommunityReport");
  const pagination = getApiPagination(req);
  const query = collection.find(filter).sort({ createdAt: -1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const reports = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
  res.json(reports.map((report) => {
    const upvotes = Array.isArray(report.upvotes) ? report.upvotes : [];
    const comments = Array.isArray(report.comments) ? report.comments : [];
    const { upvotes: _upvotes, ...fields } = report;
    return { ...toApiDocument(fields), upvotes: upvotes.length, upvoted: Boolean(req.user && upvotes.includes(req.user.id)), comments };
  }));
}

export async function getReport(req: Request, res: Response) {
  const report = await (await getCollection("CommunityReport")).findOne({ _id: req.params.id });
  if (!report || (process.env.NODE_ENV === "production" && report.isDemo === true)) return res.status(404).json({ error: "Community report not found." });
  const upvotes = Array.isArray(report.upvotes) ? report.upvotes : [];
  const comments = Array.isArray(report.comments) ? report.comments : [];
  const { upvotes: _private, ...fields } = report;
  return res.json({ ...toApiDocument(fields), upvotes: upvotes.length, upvoted: Boolean(req.user && upvotes.includes(req.user.id)), comments });
}

export async function createReport(req: Request, res: Response) {
  const report = {
    _id: randomUUID(),
    title: req.body.title,
    description: req.body.description,
    category: req.body.category,
    location: req.body.location,
    ...(Number.isFinite(req.body.latitude) ? { latitude: req.body.latitude } : {}),
    ...(Number.isFinite(req.body.longitude) ? { longitude: req.body.longitude } : {}),
    ...(Array.isArray(req.body.imageUrls) ? { imageUrls: req.body.imageUrls } : {}),
    status: "REPORTED",
    createdAt: new Date(),
    createdBy: req.user!.id,
    upvotes: [],
    comments: [],
    statusHistory: [{ status: "REPORTED", changedBy: req.user!.id, note: "Report submitted", createdAt: new Date() }],
  };
  await (await getCollection("CommunityReport")).insertOne(report);
  return res.status(201).json({ ...toApiDocument(report), upvotes: 0, upvoted: false });
}

export async function updateReportStatus(req: Request, res: Response) {
  const reports = await getCollection("CommunityReport");
  const report = await reports.findOne({ _id: req.params.id });
  if (!report) return res.status(404).json({ error: "Report not found" });
  const user = await (await getCollection("User")).findOne({ _id: req.user!.id });
  const changedAt = new Date();
  const note = req.body.resolutionDetails || req.body.reviewNote || "";
  const entry = { status: req.body.status, changedBy: req.user!.id, changedByName: user?.name ?? "Moderator", note, createdAt: changedAt };
  const statusChanged = report.status !== req.body.status;
  if (report.createdBy && statusChanged) {
    await (await getCollection("Notification")).insertOne({
      _id: randomUUID(),
      userId: report.createdBy,
      title: `Report ${req.body.status.toLowerCase().replaceAll("_", " ")}`,
      message: note || `Your report "${report.title}" status changed to ${req.body.status.toLowerCase().replaceAll("_", " ")}.`,
      createdAt: changedAt,
      read: false,
    });
  }
  const result = await reports.updateOne({ _id: req.params.id }, { $set: {
    status: req.body.status,
    reviewedAt: changedAt,
    reviewNote: req.body.reviewNote ?? "",
    ...(req.body.resolutionDetails !== undefined ? { resolutionDetails: req.body.resolutionDetails } : {}),
    ...(req.body.resolutionEvidenceUrl !== undefined ? { resolutionEvidenceUrl: req.body.resolutionEvidenceUrl } : {}),
    ...(statusChanged ? { statusHistory: [...(Array.isArray(report.statusHistory) ? report.statusHistory : []), entry] } : {}),
  } });
  if (!result.matchedCount) return res.status(404).json({ error: "Report not found" });
  if (statusChanged) await recordAdminAction(req.user!.id, "REPORT_STATUS_CHANGED", "COMMUNITY_REPORT", String(req.params.id), `${report.title}: ${report.status} → ${req.body.status}.`);
  return res.json(toApiDocument((await reports.findOne({ _id: req.params.id }))!));
}

export async function addReportComment(req: Request, res: Response) {
  const reports = await getCollection("CommunityReport");
  const report = await reports.findOne({ _id: req.params.id });
  if (!report) return res.status(404).json({ error: "Report not found" });
  const user = await (await getCollection("User")).findOne({ _id: req.user!.id });
  const comment = { id: randomUUID(), userId: req.user!.id, authorName: user?.name ?? "SustainX member", message: req.body.message, createdAt: new Date() };
  await reports.updateOne({ _id: req.params.id }, { $set: { comments: [...(Array.isArray(report.comments) ? report.comments : []), comment] } });
  res.status(201).json(comment);
}

export async function toggleReportUpvote(req: Request, res: Response) {
  const reports = await getCollection("CommunityReport");
  const report = await reports.findOne({ _id: req.params.id });
  if (!report) return res.status(404).json({ error: "Report not found" });
  const upvotes: string[] = Array.isArray(report.upvotes) ? report.upvotes : [];
  const alreadyVoted = upvotes.includes(req.user!.id);
  const next = alreadyVoted ? upvotes.filter((id) => id !== req.user!.id) : [...upvotes, req.user!.id];
  await reports.updateOne({ _id: req.params.id }, { $set: { upvotes: next } });
  res.json({ upvotes: next.length, upvoted: !alreadyVoted });
}

export async function listMine(req: Request, res: Response) {
  const activities = await (await getCollection("Activity")).find({ userId: req.user!.id }).sort({ createdAt: -1 }).toArray();
  const sdgs = await (await getCollection("Sdg")).find().toArray();
  const sdgById = new Map(sdgs.map((sdg) => [sdg._id, toApiDocument(sdg)]));
  const challenges = await (await getCollection("Challenge")).find().toArray();
  const challengeById = new Map(challenges.map((challenge) => [challenge._id, toApiDocument(challenge)]));
  res.json(activities.map((activity) => ({ ...toApiDocument(activity), sdg: sdgById.get(activity.sdgId) ?? null, challenge: activity.challengeId ? challengeById.get(activity.challengeId) ?? null : null })));
}
