import { Router } from "express";
import { z } from "zod";
import { auth, optionalAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { getChallenge, getChallengeStats, joinChallenge, listChallenges, withdrawChallenge } from "../controllers/challenge.controller";
import { addProjectDiscussion, addProjectMilestone, createProject, deleteProject, getProject, getProjectMembers, getProjectStats, inviteProjectMember, joinProject, listProjects, removeProjectMember, submitProjectEvidence, updateProject, updateProjectMembership, updateProjectMilestone } from "../controllers/project.controller";
import { addReportComment, createReport, getCommunityReportStats, getReport, listAdminReports, listMyReports, listReports, toggleReportUpvote, updateReportStatus, COMMUNITY_REPORT_CATEGORIES } from "../controllers/communityReport.controller";

const challenges = Router();
challenges.get("/stats", optionalAuth, getChallengeStats);
challenges.get("/", optionalAuth, listChallenges);
challenges.get("/:id", optionalAuth, getChallenge);
challenges.post("/:id/join", auth, joinChallenge);
challenges.post("/:id/withdraw", auth, withdrawChallenge);

const projects = Router();
const projectCategories = ["Environment", "Education", "Community", "Health", "Technology", "Agriculture", "Other"] as const;
const projectSdgNumbers = z.array(z.number().int().min(1).max(17)).min(1).max(17).refine((values) => new Set(values).size === values.length, "Choose unique SDGs.");
const projectInput = z.object({
	title: z.string().trim().min(3).max(150),
	description: z.string().trim().min(10).max(5000),
	objectives: z.array(z.string().trim().min(3).max(500)).max(20).default([]),
	category: z.enum(projectCategories),
	sdgNumbers: projectSdgNumbers,
	imageUrl: z.string().url().optional().or(z.literal("")),
	location: z.string().trim().max(200).default(""),
	startDate: z.string().datetime(),
	endDate: z.string().datetime(),
	visibility: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC"),
});
const projectUpdateInput = projectInput.partial().refine((fields) => Object.keys(fields).length > 0, "At least one project field is required.");
const milestoneInput = z.object({ title: z.string().trim().min(3).max(150), description: z.string().trim().max(2000).optional(), dueDate: z.string().datetime().optional(), assignedTo: z.string().optional() });
projects.get("/stats", optionalAuth, getProjectStats);
projects.get("/", optionalAuth, listProjects);
projects.get("/:id/members", auth, getProjectMembers);
projects.get("/:id", optionalAuth, getProject);
projects.post("/", auth, validate(projectInput), createProject);
projects.post("/:id/join", auth, joinProject);
projects.patch("/:id", auth, validate(projectUpdateInput), updateProject);
projects.delete("/:id", auth, deleteProject);
projects.post("/:id/invite", auth, validate(z.object({ email: z.string().trim().email().max(254) })), inviteProjectMember);
projects.delete("/:id/members/:memberId", auth, removeProjectMember);
projects.post("/:id/milestones", auth, validate(milestoneInput), addProjectMilestone);
projects.patch("/:id/milestones/:milestoneId", auth, validate(milestoneInput.partial().extend({ status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED"]).optional() }).refine((fields) => Object.keys(fields).length > 0, "At least one milestone field is required.")), updateProjectMilestone);
projects.post("/:id/evidence", auth, validate(z.object({ description: z.string().trim().min(10).max(2000), milestoneId: z.string().optional(), evidenceUrls: z.array(z.string().url()).min(1).max(4) })), submitProjectEvidence);
projects.patch("/:id/members/:memberId", auth, validate(z.object({ status: z.enum(["APPROVED", "REJECTED", "REMOVED"]), role: z.enum(["MEMBER", "LEADER"]).optional() })), updateProjectMembership);
projects.post("/:id/discussions", auth, validate(z.object({ message: z.string().trim().min(1).max(2000) })), addProjectDiscussion);

const reports = Router();
const reportSdgNumbers = z.array(z.number().int().min(1).max(17)).max(17).refine((values) => new Set(values).size === values.length, "SDG numbers must be unique.");
reports.get("/stats", getCommunityReportStats);
reports.get("/admin", auth, requireRole("ADMIN"), listAdminReports);
reports.get("/mine", auth, listMyReports);
reports.get("/", optionalAuth, listReports);
reports.get("/:id", optionalAuth, getReport);
reports.post("/", auth, validate(z.object({ title: z.string().trim().min(5).max(140), description: z.string().trim().min(10).max(2000), category: z.enum(COMMUNITY_REPORT_CATEGORIES), location: z.string().trim().min(2).max(180), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), imageUrls: z.array(z.string().url()).max(5).optional(), sdgNumbers: reportSdgNumbers.optional() }).refine((data) => (data.latitude === undefined) === (data.longitude === undefined), { message: "Latitude and longitude must be provided together" })), createReport);
reports.post("/:id/comments", auth, validate(z.object({ message: z.string().trim().min(1).max(1000) })), addReportComment);
reports.post("/:id/upvote", auth, toggleReportUpvote);
reports.patch("/:id/status", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["UNDER_REVIEW", "INVESTIGATING", "RESOLVED", "REJECTED"]), reviewNote: z.string().trim().max(1000).optional(), resolutionDetails: z.string().trim().max(2000).optional(), resolutionEvidenceUrl: z.string().url().optional().or(z.literal("")) }).refine((data) => data.status !== "RESOLVED" || (data.resolutionDetails?.trim().length ?? 0) >= 10, { message: "Add resolution details before resolving a report.", path: ["resolutionDetails"] }).refine((data) => data.status !== "REJECTED" || (data.reviewNote?.trim().length ?? 0) >= 5, { message: "Add a reason before rejecting a report.", path: ["reviewNote"] })), updateReportStatus);

export { challenges, projects, reports };
