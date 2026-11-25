import { Router } from "express";
import { z } from "zod";
import { apiV1Response } from "../middleware/apiV1";
import { auth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { homeRecentActivities, analyticsImpact, analyticsSdgs, listNotifications, listEnvironmentalActivities, markNotificationsRead, getActivityById } from "../controllers/apiV1.controller";
import { createActivity, myActivities } from "../controllers/activity.controller";
import { dashboard, myCertificates, publicSummary, adminOverview, verifyCertificate } from "../controllers/platform.controller";
import { listMyEnvironmentalSubmissions, listEnvironmentalSubmissions, createEnvironmentalSubmission, reviewEnvironmentalSubmission, environmentalSummary } from "../controllers/environmental.controller";
import authRoutes from "./auth.routes";
import activityRoutes from "./activity.routes";
import mediaRoutes from "./media.routes";
import sdgRoutes from "./sdg.routes";
import platformRoutes from "./platform.routes";
import chatRoutes from "./chat.routes";
import environmentalRoutes from "./environmental.routes";
import { challenges, projects, reports } from "./community.routes";

const router = Router();
router.use(apiV1Response);
const activitySubmissionSchema = z.object({
	title: z.string().min(3).max(120),
	description: z.string().min(10).max(2000),
	location: z.string().min(2).max(180),
	evidenceUrl: z.string().url().optional().or(z.literal("")),
	quantity: z.number().int().positive(),
	sdgId: z.number().int().min(1).max(17),
	challengeId: z.string().optional(),
	category: z.string().max(80).optional(),
	latitude: z.number().min(-90).max(90).optional(),
	longitude: z.number().min(-180).max(180).optional(),
	projectId: z.string().optional(),
});

router.get("/health", (_req, res) => res.json({ ok: true, name: "SustainX API", version: "v1" }));

router.use("/auth", authRoutes);
router.use("/media", mediaRoutes);
router.use("/sdgs", sdgRoutes);
router.use("/challenges", challenges);
router.use("/projects", projects);
router.use("/community/reports", reports);
router.use("/reports", reports);
router.use("/activities", activityRoutes);

const submissions = Router();
submissions.get("/", auth, myActivities);
submissions.post("/", auth, validate(activitySubmissionSchema), createActivity);
submissions.get("/:id", auth, getActivityById);
router.use("/submissions", submissions);

const ecoGuard = Router();
ecoGuard.get("/activities", listEnvironmentalActivities);
ecoGuard.get("/activities/summary", environmentalSummary);
ecoGuard.get("/summary", environmentalSummary);
ecoGuard.get("/submissions", auth, listMyEnvironmentalSubmissions);
ecoGuard.get("/submissions/mine", auth, listMyEnvironmentalSubmissions);
ecoGuard.post("/submissions", auth, validate(z.object({
	idempotencyKey: z.string().min(16).max(100),
	type: z.enum(["TREE_PLANTATION", "WATER_CONSERVATION", "WASTE_REDUCTION", "BIODIVERSITY"]),
	title: z.string().trim().min(3).max(120),
	description: z.string().trim().min(20).max(2000),
	location: z.string().trim().min(2).max(180),
	quantity: z.number().positive(),
	measurementMethod: z.string().trim().min(10).max(500).optional(),
	speciesName: z.string().trim().min(2).max(200).optional(),
	evidenceUrls: z.array(z.string().url()).min(1).max(4),
	beforeImageUrl: z.string().url().optional(),
	afterImageUrl: z.string().url().optional(),
})), createEnvironmentalSubmission);
ecoGuard.get("/admin/submissions", auth, requireRole("ADMIN"), listEnvironmentalSubmissions);
ecoGuard.patch("/submissions/:id/review", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["VERIFIED", "REJECTED"]), reviewNote: z.string().trim().min(5).max(1000) })), reviewEnvironmentalSubmission);
router.use("/ecoguard", ecoGuard);
router.use("/environmental", environmentalRoutes);

const dashboards = Router();
dashboards.get("/student", auth, requireRole("STUDENT"), dashboard);
dashboards.get("/community", auth, requireRole("COMMUNITY"), dashboard);
dashboards.get("/admin", auth, requireRole("ADMIN"), adminOverview);
dashboards.get("/me", auth, dashboard);
router.use("/dashboard", dashboards);
router.get("/home/stats", publicSummary);
router.get("/home/recent-activities", homeRecentActivities);

const notifications = Router();
notifications.use(auth);
notifications.get("/", listNotifications);
notifications.post("/read", validate(z.object({ ids: z.array(z.string().trim().min(1).max(120)).max(100).optional() })), markNotificationsRead);
router.use("/notifications", notifications);

const certificates = Router();
certificates.get("/", auth, myCertificates);
certificates.get("/mine", auth, myCertificates);
certificates.get("/verify/:id", verifyCertificate);
certificates.get("/:id", verifyCertificate);
router.use("/certificates", certificates);

const analytics = Router();
analytics.get("/impact", analyticsImpact);
analytics.get("/sdgs", analyticsSdgs);
router.use("/analytics", analytics);

router.use("/chat", chatRoutes);
router.use("/", platformRoutes);
router.use((_req, res) => res.status(404).json({ error: "API endpoint not found." }));

export default router;
