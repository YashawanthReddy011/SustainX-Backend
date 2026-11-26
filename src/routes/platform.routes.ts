import { Router } from "express";
import { z } from "zod";
import { createAdminAccount } from "../controllers/auth.controller";
import { auth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { adminActivities, adminOverview, adminUsers, dashboard, myCertificates, publicSummary, reviewActivity, verifyCertificate } from "../controllers/platform.controller";
import { archiveChallenge, createChallenge, getAdminChallenges, getChallengeParticipants, updateChallenge } from "../controllers/challenge.controller";
import { getAdminProjects, listAdminProjectEvidence, reviewProject, reviewProjectEvidence } from "../controllers/project.controller";

const router = Router();
const challengeSdgNumbers = z.array(z.number().int().min(1).max(17)).min(1).max(17).refine((values) => new Set(values).size === values.length, "SDG numbers must be unique.");
const challengeInput = z.object({
	title: z.string().trim().min(3).max(150),
	description: z.string().trim().min(10).max(3000),
	instructions: z.array(z.string().trim().min(3).max(500)).max(20).optional(),
	requirements: z.array(z.string().trim().min(3).max(500)).max(20).optional(),
	sdgNumbers: challengeSdgNumbers,
	difficulty: z.enum(["Easy", "Medium", "Hard"]),
	points: z.number().int().min(0).max(10000),
	startDate: z.string().datetime(),
	endDate: z.string().datetime(),
	requiredSubmissions: z.number().int().min(1).max(20).optional(),
	status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
});
const challengeUpdateInput = challengeInput.partial().refine((values) => Object.keys(values).length > 0, "At least one challenge field is required.");

router.get("/summary", publicSummary);
router.get("/dashboard/me", auth, dashboard);
router.get("/certificates/mine", auth, myCertificates);
router.get("/certificates/verify/:id", verifyCertificate);
router.get("/admin/overview", auth, requireRole("ADMIN"), adminOverview);
router.get("/admin/activities", auth, requireRole("ADMIN"), adminActivities);
router.patch("/admin/activities/:id/review", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["VERIFIED", "REJECTED"]), reviewNote: z.string().max(1000).optional() })), reviewActivity);
router.get("/admin/users", auth, requireRole("ADMIN"), adminUsers);
router.post("/admin/users", auth, requireRole("ADMIN"), validate(z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(254), password: z.string().min(12).max(128), role: z.enum(["STUDENT", "COMMUNITY", "ADMIN"]) })), createAdminAccount);
router.get("/admin/challenges", auth, requireRole("ADMIN"), getAdminChallenges);
router.get("/admin/challenges/:id/participants", auth, requireRole("ADMIN"), getChallengeParticipants);
router.post("/admin/challenges", auth, requireRole("ADMIN"), validate(challengeInput), createChallenge);
router.patch("/admin/challenges/:id", auth, requireRole("ADMIN"), validate(challengeUpdateInput), updateChallenge);
router.delete("/admin/challenges/:id", auth, requireRole("ADMIN"), archiveChallenge);
router.get("/admin/projects", auth, requireRole("ADMIN"), getAdminProjects);
router.patch("/admin/projects/:id/review", auth, requireRole("ADMIN"), validate(z.object({ decision: z.enum(["PUBLISH", "REJECT", "ARCHIVE"]), reviewNote: z.string().trim().max(1000).optional() })), reviewProject);
router.get("/admin/project-evidence", auth, requireRole("ADMIN"), listAdminProjectEvidence);
router.patch("/admin/project-evidence/:id/review", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["APPROVED", "REJECTED"]), reviewComment: z.string().trim().max(1000).optional() })), reviewProjectEvidence);

export default router;
