import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { getCollection, toApiDocument } from "../config/db";

export async function listChallenges(req: Request, res: Response) {
  const items = await (await getCollection("Challenge")).find({ status: { $ne: "ARCHIVED" } }).sort({ createdAt: -1 }).toArray();
  res.json(items.map((item) => {
    const joinedUserIds = Array.isArray(item.joinedUserIds) ? item.joinedUserIds : [];
    const { joinedUserIds: _private, ...fields } = item;
    return { ...toApiDocument(fields), participants: Number(item.participants ?? joinedUserIds.length), joined: Boolean(req.user && joinedUserIds.includes(req.user.id)) };
  }));
}

export async function joinChallenge(req: Request, res: Response) {
  const challenges = await getCollection("Challenge");
  const id = req.params.id;
  const challenge = await challenges.findOne({ _id: id });
  if (!challenge) return res.status(404).json({ error: "Challenge not found" });
  const joined = Array.isArray(challenge.joinedUserIds) && challenge.joinedUserIds.includes(req.user!.id);
  if (!joined) await challenges.updateOne({ _id: id }, { $addToSet: { joinedUserIds: req.user!.id }, $inc: { participants: 1 } });
  return res.json({ id, joined: true });
}

export async function listProjects(req: Request, res: Response) {
  const items = await (await getCollection("Project")).find({ status: { $ne: "ARCHIVED" } }).sort({ createdAt: -1 }).toArray();
  res.json(items.map((item) => {
    const memberIds = Array.isArray(item.memberIds) ? item.memberIds : [];
    const { memberIds: _private, ...fields } = item;
    return { ...toApiDocument(fields), members: Number(item.members ?? memberIds.length), joined: Boolean(req.user && memberIds.includes(req.user.id)) };
  }));
}

export async function createProject(req: Request, res: Response) {
  const owner = await (await getCollection("User")).findOne({ _id: req.user!.id });
  const project = {
    _id: randomUUID(),
    title: req.body.title,
    description: req.body.description,
    sdgId: req.body.sdgId,
    location: req.body.location ?? "",
    ...(req.body.imageUrl ? { imageUrl: req.body.imageUrl } : {}),
    ownerId: req.user!.id,
    ownerName: owner?.name ?? "SustainX member",
    memberIds: [req.user!.id],
    members: 1,
    progress: 0,
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
  if (!project) return res.status(404).json({ error: "Project not found" });
  const memberIds = Array.isArray(project.memberIds) ? project.memberIds : [];
  if (!memberIds.includes(req.user!.id)) await projects.updateOne({ _id: id }, { $addToSet: { memberIds: req.user!.id }, $inc: { members: 1 } });
  return res.json({ id, joined: true });
}

export async function updateProject(req: Request, res: Response) {
  const projects = await getCollection("Project");
  const result = await projects.updateOne({ _id: req.params.id }, { $set: { ...(req.body.status ? { status: req.body.status } : {}), ...(typeof req.body.progress === "number" ? { progress: req.body.progress } : {}) } });
  if (!result.matchedCount) return res.status(404).json({ error: "Project not found" });
  return res.json(toApiDocument((await projects.findOne({ _id: req.params.id }))!));
}

export async function listReports(_req: Request, res: Response) {
  const reports = await (await getCollection("CommunityReport")).find().sort({ createdAt: -1 }).toArray();
  res.json(reports.map(toApiDocument));
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
    status: "REPORTED",
    createdAt: new Date(),
    createdBy: req.user!.id,
  };
  await (await getCollection("CommunityReport")).insertOne(report);
  return res.status(201).json(toApiDocument(report));
}

export async function updateReportStatus(req: Request, res: Response) {
  const reports = await getCollection("CommunityReport");
  const result = await reports.updateOne({ _id: req.params.id }, { $set: { status: req.body.status, reviewedAt: new Date(), reviewNote: req.body.reviewNote ?? "" } });
  if (!result.matchedCount) return res.status(404).json({ error: "Report not found" });
  return res.json(toApiDocument((await reports.findOne({ _id: req.params.id }))!));
}

export async function listMine(req: Request, res: Response) {
  const activities = await (await getCollection("Activity")).find({ userId: req.user!.id }).sort({ createdAt: -1 }).toArray();
  const sdgs = await (await getCollection("Sdg")).find().toArray();
  const sdgById = new Map(sdgs.map((sdg) => [sdg._id, toApiDocument(sdg)]));
  const challenges = await (await getCollection("Challenge")).find().toArray();
  const challengeById = new Map(challenges.map((challenge) => [challenge._id, toApiDocument(challenge)]));
  res.json(activities.map((activity) => ({ ...toApiDocument(activity), sdg: sdgById.get(activity.sdgId) ?? null, challenge: activity.challengeId ? challengeById.get(activity.challengeId) ?? null : null })));
}
