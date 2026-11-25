import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { getCollection } from "../config/db";

export function authRateLimit(maxAttempts: number, windowMs: number, identity?: (req: Request) => string) {
	return async (req: Request, res: Response, next: NextFunction) => {
		const now = new Date();
		const resetAt = new Date(now.getTime() + windowMs);
		const clientAddress = req.ip || req.socket.remoteAddress || "unknown";
		const scope = `${req.baseUrl}${req.path}`;
		const identityValue = identity?.(req).trim().toLowerCase() || "";
		const identityKey = identityValue
			? `:${createHash("sha256").update(identityValue).digest("hex")}`
			: "";
		const key = `${scope}:${clientAddress}${identityKey}`;
		const resetCondition = {
			$or: [
				{ $eq: [{ $type: "$resetAt" }, "missing"] },
				{ $lte: ["$resetAt", now] },
			],
		};
		const pipeline = [{
			$set: {
				count: { $cond: [resetCondition, 1, { $add: [{ $ifNull: ["$count", 0] }, 1] }] },
				resetAt: { $cond: [resetCondition, resetAt, "$resetAt"] },
			},
		}];

		try {
			const limits = await getCollection("AuthRateLimit");
			let bucket: any;
			try {
				bucket = await limits.findOneAndUpdate(
					{ _id: key },
					pipeline,
					{ upsert: true, returnDocument: "after", includeResultMetadata: false }
				);
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error;
				bucket = await limits.findOneAndUpdate(
					{ _id: key },
					pipeline,
					{ returnDocument: "after", includeResultMetadata: false }
				);
			}
			if (Number(bucket?.count ?? 0) > maxAttempts) {
				const retryAfterSeconds = Math.max(1, Math.ceil((new Date(bucket.resetAt).getTime() - Date.now()) / 1000));
				res.setHeader("Retry-After", String(retryAfterSeconds));
				return res.status(429).json({ error: "Too many attempts. Try again later.", retryAfterSeconds });
			}
			return next();
		} catch (error) {
			return next(error);
		}
	};
}
