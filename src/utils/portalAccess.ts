import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import type { Role } from "../types";

export type LoginPortal = "STUDENT" | "DASHBOARD" | "ADMIN";

const ROLE_BY_PORTAL: Record<LoginPortal, Role> = {
	STUDENT: "STUDENT",
	DASHBOARD: "COMMUNITY",
	ADMIN: "ADMIN",
};

export function roleForLoginPortal(portal: LoginPortal): Role {
	return ROLE_BY_PORTAL[portal];
}

export function matchesPortalAccessKey(portal: LoginPortal, candidate: string) {
	if (portal === "STUDENT") return true;
	const configuredKey = portal === "ADMIN" ? env.adminAccessKey : env.dashboardAccessKey;
	if (!configuredKey || !candidate) return false;
	const expected = createHmac("sha256", env.jwtSecret).update(configuredKey).digest();
	const supplied = createHmac("sha256", env.jwtSecret).update(candidate).digest();
	return timingSafeEqual(expected, supplied);
}
