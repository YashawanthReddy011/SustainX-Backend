import {
  NextFunction,
  Request,
  Response,
} from "express";

import { verifyToken } from "../utils/jwt";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role:
          | "STUDENT"
          | "COMMUNITY"
          | "ADMIN";
      };
    }
  }
}

export function auth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({
        error: "Authentication required",
      });
  }

  try {
    const token = header.slice(7);
    req.user = verifyToken(token);
    next();
  } catch {
    return res
      .status(401)
      .json({
        error: "Invalid or expired token",
      });
  }
}

export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      req.user = verifyToken(header.slice(7));
    } catch {
      // Public listing endpoints remain usable when a stale token is present.
    }
  }
  next();
}

export function requireRole(
  ...roles: Array<"STUDENT" | "COMMUNITY" | "ADMIN">
) {
  return (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({
          error: "Forbidden",
        });
    }

    next();
  };
}
