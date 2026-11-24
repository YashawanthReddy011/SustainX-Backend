import {
  Request,
  Response,
} from "express";

import { getCollection, toApiDocument } from "../config/db";
import { signToken } from "../utils/jwt";

export async function login(
  req: Request,
  res: Response
) {
  const email = String(req.body.email).trim().toLowerCase();

  const users = await getCollection("User");
  const user = await users.findOne({ email });

  if (!user) {
    return res
      .status(401)
      .json({
        error: "Invalid demo credentials",
      });
  }

  const token = signToken({
    id: String(user._id),
    role: user.role,
  });

  res.json({
    token,
    user: {
      id: String(user._id),
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
  const users = await getCollection("User");
  const user = await users.findOne(
    { _id: req.user!.id },
    { projection: { name: 1, email: 1, role: 1, impactPoints: 1 } }
  );

  res.json(user ? toApiDocument(user) : null);
}
