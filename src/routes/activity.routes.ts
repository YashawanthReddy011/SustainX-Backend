import { Router } from "express";
import { z } from "zod";

import { auth, optionalAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  createActivity,
  listActivities,
  myActivities,
} from "../controllers/activity.controller";
import { reviewActivity } from "../controllers/platform.controller";
import { getActivityById } from "../controllers/apiV1.controller";

const router = Router();

const schema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  location: z.string().min(2),
  evidenceUrl: z.string().url().optional().or(z.literal("")),
  quantity: z.number().int().positive(),
  sdgId: z.number().int().min(1).max(17),
  challengeId: z.string().optional(),
  category: z.string().max(80).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  projectId: z.string().optional(),
});

const reviewSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reviewNote: z.string().max(1000).optional(),
});

router.get("/", optionalAuth, listActivities);

router.get("/mine", auth, myActivities);
router.get("/:id", auth, getActivityById);

router.post("/", auth, validate(schema), createActivity);
router.patch("/:id/review", auth, requireRole("ADMIN"), validate(reviewSchema), reviewActivity);

export default router;
