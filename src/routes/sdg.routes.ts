import { Router } from "express";

import {
  getSdg,
  listSdgs,
  updateSdg,
} from "../controllers/sdg.controller";
import { auth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { z } from "zod";

const router = Router();

router.get("/", listSdgs);

router.get("/:id", getSdg);
router.patch("/:id", auth, requireRole("ADMIN"), validate(z.object({
  title: z.string().min(3).max(120).optional(),
  shortDescription: z.string().min(5).max(300).optional(),
  description: z.string().min(5).max(2000).optional(),
  actions: z.array(z.string().min(3).max(200)).max(12).optional(),
  targets: z.array(z.string().min(3).max(200)).max(12).optional(),
})), updateSdg);

export default router;
