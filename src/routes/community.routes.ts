import { Router } from "express";
import { z } from "zod";
import { auth, optionalAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { projectMembers } from "../controllers/apiV1.controller";
import { addProjectDiscussion, addProjectMilestone, addReportComment, createProject, createReport, deleteProject, getChallenge, getProject, getReport, inviteProjectMember, joinChallenge, joinProject, listChallenges, listProjects, listReports, removeProjectMember, toggleReportUpvote, updateProject, updateProjectMilestone, updateReportStatus } from "../controllers/community.controller";

const challenges = Router();
challenges.get("/", optionalAuth, listChallenges);
challenges.get("/:id", optionalAuth, getChallenge);
challenges.post("/:id/join", auth, joinChallenge);

const projects = Router();
projects.get("/", optionalAuth, listProjects);
projects.get("/:id/members", auth, projectMembers);
projects.get("/:id", optionalAuth, getProject);
projects.post("/", auth, validate(z.object({ title: z.string().min(3).max(120), description: z.string().min(10).max(2000), sdgId: z.number().int().min(1).max(17).optional(), sdgNumbers: z.array(z.number().int().min(1).max(17)).min(1).max(17).optional(), location: z.string().max(180).optional(), imageUrl: z.string().url().optional().or(z.literal("")) })), createProject);
projects.post("/:id/join", auth, joinProject);
projects.patch("/:id", auth, validate(z.object({ title: z.string().min(3).max(120).optional(), description: z.string().min(10).max(2000).optional(), sdgId: z.number().int().min(1).max(17).optional(), sdgNumbers: z.array(z.number().int().min(1).max(17)).min(1).max(17).optional(), location: z.string().max(180).optional(), imageUrl: z.string().url().optional().or(z.literal("")), status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(), progress: z.number().int().min(0).max(100).optional() })), updateProject);
projects.delete("/:id", auth, deleteProject);
projects.post("/:id/invite", auth, validate(z.object({ email: z.string().email() })), inviteProjectMember);
projects.delete("/:id/members/:memberId", auth, removeProjectMember);
projects.post("/:id/milestones", auth, validate(z.object({ title: z.string().min(3).max(140), dueDate: z.string().datetime().optional(), status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED"]).optional() })), addProjectMilestone);
projects.patch("/:id/milestones/:milestoneId", auth, validate(z.object({ title: z.string().min(3).max(140).optional(), dueDate: z.string().datetime().optional(), status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED"]).optional() })), updateProjectMilestone);
projects.post("/:id/discussions", auth, validate(z.object({ message: z.string().trim().min(1).max(2000) })), addProjectDiscussion);

const reports = Router();
reports.get("/", optionalAuth, listReports);
reports.get("/:id", optionalAuth, getReport);
reports.post("/", auth, validate(z.object({ title: z.string().min(5).max(140), description: z.string().min(10).max(2000), category: z.string().min(2).max(80), location: z.string().min(2).max(180), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), imageUrls: z.array(z.string().url()).max(5).optional() }).refine((data) => (data.latitude === undefined) === (data.longitude === undefined), { message: "Latitude and longitude must be provided together" })), createReport);
reports.post("/:id/comments", auth, validate(z.object({ message: z.string().trim().min(1).max(1000) })), addReportComment);
reports.post("/:id/upvote", auth, toggleReportUpvote);
reports.patch("/:id/status", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED"]), reviewNote: z.string().max(1000).optional(), resolutionDetails: z.string().max(2000).optional(), resolutionEvidenceUrl: z.string().url().optional().or(z.literal("")) }).refine((data) => data.status !== "RESOLVED" || Boolean(data.resolutionDetails?.trim()), { message: "Resolution details are required when resolving a report", path: ["resolutionDetails"] })), updateReportStatus);

export { challenges, projects, reports };
