import {
  NextFunction,
  Request,
  Response,
} from "express";
import { logger } from "../utils/logger";

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error("Unhandled API error", {
    requestId: _req.requestId,
    method: _req.method,
    path: _req.originalUrl,
    ...logger.formatError(error),
  });

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: "Internal server error",
  });
}
