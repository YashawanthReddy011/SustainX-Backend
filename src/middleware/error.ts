import {
  NextFunction,
  Request,
  Response,
} from "express";

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error(error);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: "Internal server error",
  });
}
