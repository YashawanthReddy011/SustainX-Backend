import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
	namespace Express {
		interface Request { requestId?: string }
	}
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
	const incoming = req.header("x-request-id");
	const requestId = incoming && /^[a-zA-Z0-9._-]{1,100}$/.test(incoming) ? incoming : randomUUID();
	req.requestId = requestId;
	res.setHeader("X-Request-Id", requestId);
	return next();
}
