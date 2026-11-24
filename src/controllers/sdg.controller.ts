import {
  Request,
  Response,
} from "express";

import { getCollection, toApiDocument } from "../config/db";

function sdgToApi(document: Record<string, any>) {
  return {
    id: document._id,
    code: document.shortName ?? `SDG ${document._id}`,
    title: document.name ?? `Sustainable Development Goal ${document._id}`,
    shortDescription: document.description ?? "",
    description: document.description ?? "",
    color: document.color,
    actions: document.actions ?? [],
    targets: document.targets ?? [],
  };
}

export async function listSdgs(
  _req: Request,
  res: Response
) {
  const sdgs = await (await getCollection("Sdg"))
    .find()
    .sort({ _id: 1 })
    .toArray();

  res.json(sdgs.map(sdgToApi));
}

export async function getSdg(
  req: Request,
  res: Response
) {
  const id = Number(req.params.id);

  const sdg = await (await getCollection("Sdg")).findOne({ _id: id });

  if (!sdg) {
    return res
      .status(404)
      .json({
        error: "SDG not found",
      });
  }

  res.json(sdgToApi(sdg));
}

export async function updateSdg(req: Request, res: Response) {
  const id = Number(req.params.id);
  const result = await (await getCollection("Sdg")).updateOne(
    { _id: id },
    { $set: {
      ...(req.body.title ? { name: req.body.title } : {}),
      ...(req.body.shortDescription ? { description: req.body.shortDescription } : {}),
      ...(req.body.description ? { longDescription: req.body.description } : {}),
      ...(req.body.actions ? { actions: req.body.actions } : {}),
      ...(req.body.targets ? { targets: req.body.targets } : {}),
    } }
  );
  if (!result.matchedCount) return res.status(404).json({ error: "SDG not found" });
  return res.json(sdgToApi((await (await getCollection("Sdg")).findOne({ _id: id }))!));
}
