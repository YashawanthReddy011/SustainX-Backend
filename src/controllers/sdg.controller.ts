import {
  Request,
  Response,
} from "express";

import { prisma } from "../config/db";

export async function listSdgs(
  _req: Request,
  res: Response
) {
  const sdgs = await prisma.sdg.findMany({
    orderBy: {
      id: "asc",
    },
  });

  res.json(sdgs);
}

export async function getSdg(
  req: Request,
  res: Response
) {
  const id = Number(req.params.id);

  const sdg = await prisma.sdg.findUnique({
    where: {
      id,
    },
  });

  if (!sdg) {
    return res
      .status(404)
      .json({
        error: "SDG not found",
      });
  }

  res.json(sdg);
}
