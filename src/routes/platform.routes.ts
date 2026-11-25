import { Router } from "express";
import { z } from "zod";
import { createAdminAccount } from "../controllers/auth.controller";
import { auth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { adminActivities, adminOverview, adminUsers, dashboard, myCertificates, publicSummary, reviewActivity, verifyCertificate } from "../controllers/platform.controller";

const router = Router();
router.get("/summary", publicSummary);
router.get("/dashboard/me", auth, dashboard);
router.get("/certificates/mine", auth, myCertificates);
router.get("/certificates/verify/:id", verifyCertificate);
router.get("/admin/overview", auth, requireRole("ADMIN"), adminOverview);
router.get("/admin/activities", auth, requireRole("ADMIN"), adminActivities);
router.patch("/admin/activities/:id/review", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["VERIFIED", "REJECTED"]), reviewNote: z.string().max(1000).optional() })), reviewActivity);
router.get("/admin/users", auth, requireRole("ADMIN"), adminUsers);
router.post("/admin/users", auth, requireRole("ADMIN"), validate(z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(254), password: z.string().min(12).max(128), role: z.enum(["STUDENT", "COMMUNITY", "ADMIN"]) })), createAdminAccount);

export default router;
