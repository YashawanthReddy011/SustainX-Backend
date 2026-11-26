import { Router } from "express";
import { z } from "zod";
import { auth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  createEnvironmentalSubmission,
  environmentalSummary,
  listEnvironmentalSubmissions,
  listMyEnvironmentalSubmissions,
  reviewEnvironmentalSubmission,
} from "../controllers/environmental.controller";

const router = Router();

const submissionSchema = z.object({
  idempotencyKey: z.string().min(16).max(100),
  type: z.enum(["TREE_PLANTATION", "TREE_SURVIVAL", "WATER_CONSERVATION", "RENEWABLE_ENERGY", "WASTE_REDUCTION", "CLIMATE_ACTION", "MARINE_PROTECTION", "BIODIVERSITY"]),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(20).max(2000),
  location: z.string().trim().min(2).max(180),
  activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  quantity: z.number().positive(),
  measurementMethod: z.string().trim().min(10).max(500).optional(),
  speciesName: z.string().trim().min(2).max(200).optional(),
  evidenceUrls: z.array(z.string().url()).min(1).max(4),
  beforeImageUrl: z.string().url().optional(),
  afterImageUrl: z.string().url().optional(),
});

router.get("/summary", environmentalSummary);
router.get("/submissions/mine", auth, listMyEnvironmentalSubmissions);
router.post("/submissions", auth, validate(submissionSchema), createEnvironmentalSubmission);
router.get("/submissions", auth, requireRole("ADMIN"), listEnvironmentalSubmissions);
router.patch(
  "/submissions/:id/review",
  auth,
  requireRole("ADMIN"),
  validate(z.object({
    status: z.enum(["VERIFIED", "REJECTED"]),
    reviewNote: z.string().trim().min(5).max(1000),
  })),
  reviewEnvironmentalSubmission
);

export default router;
