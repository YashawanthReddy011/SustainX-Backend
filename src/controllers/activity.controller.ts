import {
  Request,
  Response,
} from "express";
import { randomUUID } from "node:crypto";

import { Document } from "mongodb";
import { getCollection, toApiDocument } from "../config/db";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";
import { calculatePoints } from "../utils/points";

function activityToApi(document: Document) {
  const activity = toApiDocument(document) as Record<string, any>;
  activity.user = document.user ? { name: document.user.name } : undefined;
  activity.sdg = document.sdg ? toApiDocument(document.sdg) : null;
  activity.challenge = document.challenge
    ? toApiDocument(document.challenge)
    : null;
  return activity;
}

function activityJoins() {
  return [
    {
      $lookup: {
        from: "Sdg",
        localField: "sdgId",
        foreignField: "_id",
        as: "sdg",
      },
    },
    { $unwind: { path: "$sdg", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "Challenge",
        localField: "challengeId",
        foreignField: "_id",
        as: "challenge",
      },
    },
    { $unwind: { path: "$challenge", preserveNullAndEmptyArrays: true } },
  ];
}

export async function listActivities(
  req: Request,
  res: Response
) {
  const filter: Document = {};
  const requestedStatus = typeof req.query.status === "string" && req.query.status !== "ALL" ? req.query.status : undefined;
  if (requestedStatus && !["PENDING", "VERIFIED", "REJECTED", "NEEDS_INFO"].includes(requestedStatus)) return res.status(400).json({ error: "status is not a supported submission status." });
  if (requestedStatus && requestedStatus !== "VERIFIED" && req.user?.role !== "ADMIN") return res.status(403).json({ error: "Only administrators can view unverified submissions." });
  if (requestedStatus) filter.status = requestedStatus;
  else if (req.user?.role !== "ADMIN") filter.status = "VERIFIED";
  if (req.user?.role !== "ADMIN") filter.isDemo = { $ne: true };
  if (typeof req.query.sdgId === "string") {
    const sdgId = Number(req.query.sdgId);
    if (!Number.isInteger(sdgId) || sdgId < 1 || sdgId > 17) return res.status(400).json({ error: "sdgId must be an integer between 1 and 17." });
    filter.sdgId = sdgId;
  }
  for (const key of ["challengeId", "projectId"] as const) {
    if (typeof req.query[key] === "string" && req.query[key]) filter[key] = req.query[key];
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
  if (search) filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const collection = await getCollection("Activity");
  const pagination = getApiPagination(req);
  const pipeline: Document[] = [
      { $match: filter },
      ...activityJoins(),
      {
        $lookup: {
          from: "User",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      { $sort: { createdAt: -1 } },
  ];
  if (pagination.enabled) pipeline.push({ $skip: pagination.skip }, { $limit: pagination.limit });
  const activities = await collection.aggregate(pipeline).toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));

  res.json(activities.map(activityToApi));
}

export async function createActivity(
  req: Request,
  res: Response
) {
  const { title, description, location, evidenceUrl, quantity, sdgId, challengeId, category, latitude, longitude, projectId } = req.body;
  const sdgs = await getCollection("Sdg");
  if (!(await sdgs.findOne({ _id: sdgId }))) {
    return res.status(400).json({ error: "SDG not found" });
  }
  if (challengeId && !(await (await getCollection("Challenge")).findOne({ _id: challengeId }))) {
    return res.status(400).json({ error: "Challenge not found" });
  }
  if (challengeId) {
    const challenge = await (await getCollection("Challenge")).findOne({ _id: challengeId });
    const participation = await (await getCollection("ChallengeParticipation")).findOne({ challengeId, userId: req.user!.id, status: { $ne: "WITHDRAWN" } });
    const legacyJoined = Array.isArray(challenge?.joinedUserIds) && challenge.joinedUserIds.includes(req.user!.id);
    if (!participation && !legacyJoined) return res.status(403).json({ error: "Join this challenge before submitting evidence." });
    if (participation?.status === "COMPLETED") return res.status(409).json({ error: "This challenge is already complete for your account." });
  }

  const activity = {
    _id: randomUUID(),
    title,
    description,
    location,
    ...(evidenceUrl ? { evidenceUrl } : {}),
    quantity,
    ...(category ? { category } : {}),
    ...(typeof latitude === "number" ? { latitude } : {}),
    ...(typeof longitude === "number" ? { longitude } : {}),
    status: "PENDING",
    points: calculatePoints(quantity),
    userId: req.user!.id,
    sdgId,
    ...(challengeId ? { challengeId } : {}),
    ...(projectId ? { projectId } : {}),
    createdAt: new Date(),
    reviewedAt: null,
    reviewNote: null,
  };
  await (await getCollection("Activity")).insertOne(activity);

  if (challengeId) {
    await (await getCollection("ChallengeParticipation")).updateOne(
      { challengeId, userId: req.user!.id },
      {
        $set: { status: "IN_PROGRESS", updatedAt: activity.createdAt },
        $setOnInsert: { _id: randomUUID(), progress: 0, joinedAt: activity.createdAt, createdAt: activity.createdAt },
      },
      { upsert: true },
    );
  }

  res
    .status(201)
    .json(toApiDocument(activity));
}

export async function myActivities(
  req: Request,
  res: Response
) {
  const filter: Document = { userId: req.user!.id };
  if (typeof req.query.status === "string" && req.query.status !== "ALL") {
    if (!["PENDING", "VERIFIED", "REJECTED", "NEEDS_INFO"].includes(req.query.status)) return res.status(400).json({ error: "status is not a supported submission status." });
    filter.status = req.query.status;
  }
  const collection = await getCollection("Activity");
  const pagination = getApiPagination(req);
  const pipeline: Document[] = [
      { $match: filter },
      ...activityJoins(),
      { $sort: { createdAt: -1 } },
  ];
  if (pagination.enabled) pipeline.push({ $skip: pagination.skip }, { $limit: pagination.limit });
  const activities = await collection.aggregate(pipeline).toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));

  res.json(activities.map(activityToApi));
}
