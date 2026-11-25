import type { NextFunction, Request, Response } from "express";

type ApiEnvelope<T = unknown> = {
	success: boolean;
	data?: T;
	error?: string;
	details?: unknown;
	meta?: { page: number; limit: number; total: number; totalPages: number };
};

export function getApiPagination(req: Request) {
	const enabled = req.originalUrl.startsWith("/api/v1/") || req.originalUrl === "/api/v1";
	const page = Number(req.query.page) || 1;
	const limit = Number(req.query.limit) || 25;
	return { enabled, page, limit, skip: (page - 1) * limit };
}

export function setApiPaginationTotal(req: Request, res: Response, total: number) {
	if (req.originalUrl.startsWith("/api/v1/") || req.originalUrl === "/api/v1") {
		res.locals.apiPaginationTotal = total;
	}
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

export function apiV1Response(req: Request, res: Response, next: NextFunction) {
	const page = positiveInteger(req.query.page, 1, 1_000_000);
	const limit = positiveInteger(req.query.limit, 25, 100);
	const sendJson = res.json.bind(res);

	res.json = ((body: unknown) => {
		if (res.statusCode >= 400) {
			const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
			const originalError = payload.error;
			const response: ApiEnvelope = {
				success: false,
				error: typeof originalError === "string" ? originalError : "Request failed.",
				...(originalError !== undefined && typeof originalError !== "string" ? { details: originalError } : {}),
			};
			return sendJson(response);
		}

		if (typeof body === "object" && body !== null && "success" in body && "data" in body) {
			return sendJson(body);
		}
		if (Array.isArray(body) && req.method === "GET") {
			const currentPage = page ?? 1;
			const currentLimit = limit ?? 25;
			const start = (currentPage - 1) * currentLimit;
			const databaseTotal = res.locals.apiPaginationTotal;
			const data = typeof databaseTotal === "number" ? body : body.slice(start, start + currentLimit);
			return sendJson({
				success: true,
				data,
				meta: {
					page: currentPage,
					limit: currentLimit,
					total: typeof databaseTotal === "number" ? databaseTotal : body.length,
					totalPages: Math.ceil((typeof databaseTotal === "number" ? databaseTotal : body.length) / currentLimit),
				},
			});
		}
		return sendJson({ success: true, data: body });
	}) as Response["json"];

	if (page === null || limit === null) {
		return res.status(400).json({ error: "page must be a positive integer and limit must be between 1 and 100." });
	}
	return next();
}
