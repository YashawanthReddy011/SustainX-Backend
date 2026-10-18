import {
  Request,
  Response,
} from "express";

import { prisma } from "../config/db";
import { signToken } from "../utils/jwt";

export async function login(
  req: Request,
  res: Response
) {
  const { email } = req.body;

  const user = await prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!user) {
    return res
      .status(401)
      .json({
        error: "Invalid demo credentials",
      });
  }

  const token = signToken({
    id: user.id,
    role: user.role,
  });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      impactPoints: user.impactPoints,
    },
  });
}

export async function me(
  req: Request,
  res: Response
) {
  const user = await prisma.user.findUnique({
    where: {
      id: req.user!.id,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      impactPoints: true,
    },
  });

  res.json(user);
}
