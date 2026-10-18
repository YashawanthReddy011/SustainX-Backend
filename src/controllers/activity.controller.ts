import {
  Request,
  Response,
} from "express";

import { prisma } from "../config/db";
import { calculatePoints } from "../utils/points";

export async function listActivities(
  _req: Request,
  res: Response
) {
  const activities = await prisma.activity.findMany({
    include: {
      user: {
        select: {
          name: true,
        },
      },
      sdg: true,
      challenge: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res.json(activities);
}

export async function createActivity(
  req: Request,
  res: Response
) {
  const activity = await prisma.activity.create({
    data: {
      ...req.body,
      userId: req.user!.id,
      points: calculatePoints(req.body.quantity),
    },
  });

  res
    .status(201)
    .json(activity);
}

export async function myActivities(
  req: Request,
  res: Response
) {
  const activities = await prisma.activity.findMany({
    where: {
      userId: req.user!.id,
    },
    include: {
      sdg: true,
      challenge: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res.json(activities);
}
