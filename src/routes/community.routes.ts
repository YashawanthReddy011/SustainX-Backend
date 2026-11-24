import { Router } from "express";
import { z } from "zod";
import { auth, optionalAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { createProject, createReport, joinChallenge, joinProject, listChallenges, listProjects, listReports, updateProject, updateReportStatus } from "../controllers/community.controller";

const challenges = Router();
challenges.get("/", optionalAuth, listChallenges);
challenges.post("/:id/join", auth, joinChallenge);

const projects = Router();
projects.get("/", optionalAuth, listProjects);
projects.post("/", auth, validate(z.object({ title: z.string().min(3).max(120), description: z.string().min(10).max(2000), sdgId: z.number().int().min(1).max(17), location: z.string().max(180).optional(), imageUrl: z.string().url().optional().or(z.literal("")) })), createProject);
projects.post("/:id/join", auth, joinProject);
projects.patch("/:id", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(), progress: z.number().int().min(0).max(100).optional() })), updateProject);

const reports = Router();
reports.get("/", listReports);
reports.post("/", auth, validate(z.object({ title: z.string().min(5).max(140), description: z.string().min(10).max(2000), category: z.string().min(2).max(80), location: z.string().min(2).max(180), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() })), createReport);
reports.patch("/:id/status", auth, requireRole("ADMIN"), validate(z.object({ status: z.enum(["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED"]), reviewNote: z.string().max(1000).optional() })), updateReportStatus);

export { challenges, projects, reports };
