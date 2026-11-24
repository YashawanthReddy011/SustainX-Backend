import {
  Request,
  Response,
} from "express";
import { randomUUID } from "node:crypto";

import { Document } from "mongodb";
import { getCollection, toApiDocument } from "../config/db";
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
  const pipeline: Document[] = [];
  if (typeof req.query.status === "string") pipeline.push({ $match: { status: req.query.status } });
  const activities = await (await getCollection("Activity"))
    .aggregate([
      ...pipeline,
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
    ])
    .toArray();

  res.json(activities.map(activityToApi));
}

export async function createActivity(
  req: Request,
  res: Response
) {
  const { title, description, location, evidenceUrl, quantity, sdgId, challengeId, category, latitude, longitude } = req.body;
  const sdgs = await getCollection("Sdg");
  if (!(await sdgs.findOne({ _id: sdgId }))) {
    return res.status(400).json({ error: "SDG not found" });
  }
  if (challengeId && !(await (await getCollection("Challenge")).findOne({ _id: challengeId }))) {
    return res.status(400).json({ error: "Challenge not found" });
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
    createdAt: new Date(),
    reviewedAt: null,
    reviewNote: null,
  };
  await (await getCollection("Activity")).insertOne(activity);

  res
    .status(201)
    .json(toApiDocument(activity));
}

export async function myActivities(
  req: Request,
  res: Response
) {
  const activities = await (await getCollection("Activity"))
    .aggregate([
      { $match: { userId: req.user!.id } },
      ...activityJoins(),
      { $sort: { createdAt: -1 } },
    ])
    .toArray();

  res.json(activities.map(activityToApi));
}
