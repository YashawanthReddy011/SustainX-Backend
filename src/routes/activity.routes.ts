import { Router } from "express";
import { z } from "zod";

import { auth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  createActivity,
  listActivities,
  myActivities,
} from "../controllers/activity.controller";

const router = Router();

const schema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  location: z.string().min(2),
  evidenceUrl: z.string().url().optional().or(z.literal("")),
  quantity: z.number().int().positive(),
  sdgId: z.number().int().min(1).max(17),
  challengeId: z.string().optional(),
});

router.get("/", listActivities);

router.get("/mine", auth, myActivities);

router.post("/", auth, validate(schema), createActivity);

export default router;
