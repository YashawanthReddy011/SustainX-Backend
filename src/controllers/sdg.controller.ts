import {
  Request,
  Response,
} from "express";

import { getCollection, toApiDocument } from "../config/db";
import { recordAdminAction } from "../services/adminAudit.service";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";

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
    category: document.category ?? (document._id <= 3 ? "People" : document._id <= 10 ? "Prosperity" : document._id <= 15 ? "Planet" : "Partnership"),
    isActive: document.isActive !== false,
  };
}

export async function listSdgs(req: Request, res: Response) {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.category === "string" && req.query.category !== "All") {
    const categoryRanges: Record<string, { $gte: number; $lte: number }> = {
      People: { $gte: 1, $lte: 3 },
      Prosperity: { $gte: 4, $lte: 10 },
      Planet: { $gte: 11, $lte: 15 },
      Partnership: { $gte: 16, $lte: 17 },
    };
    const range = categoryRanges[req.query.category];
    if (!range) return res.status(400).json({ error: "category is not a supported SDG category." });
    filter._id = range;
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const numericId = Number(search);
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
      ...(Number.isInteger(numericId) && numericId >= 1 && numericId <= 17 ? [{ _id: numericId }] : []),
    ];
  }
  const collection = await getCollection("Sdg");
  const pagination = getApiPagination(req);
  const query = collection.find(filter).sort({ _id: 1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const sdgs = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));

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

  const [challenges, projects, activities] = await Promise.all([
    (await getCollection("Challenge")).find({ sdgId: id, status: { $ne: "ARCHIVED" } }).sort({ createdAt: -1 }).limit(6).toArray(),
    (await getCollection("Project")).find({ sdgId: id, status: { $ne: "ARCHIVED" } }).sort({ createdAt: -1 }).limit(6).toArray(),
    (await getCollection("Activity")).find({ sdgId: id, status: "VERIFIED", isDemo: { $ne: true } }).sort({ reviewedAt: -1, createdAt: -1 }).limit(6).toArray(),
  ]);
  const allActivities = await (await getCollection("Activity")).find({ sdgId: id, isDemo: { $ne: true } }).toArray();
  const completed = allActivities.filter((item) => item.status === "VERIFIED").length;
  res.json({
    ...sdgToApi(sdg),
    isActive: sdg.isActive !== false,
    category: id <= 3 ? "People" : id <= 10 ? "Prosperity" : id <= 15 ? "Planet" : "Partnership",
    progress: allActivities.length ? Math.round((completed / allActivities.length) * 100) : 0,
    completedActions: completed,
    totalActions: allActivities.length,
    relatedChallenges: challenges.map(toApiDocument),
    relatedProjects: projects.map(toApiDocument),
    relatedActivities: activities.map(toApiDocument),
  });
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
  await recordAdminAction(req.user!.id, "SDG_UPDATED", "SDG", String(id), `Updated SDG ${id}.`);
  return res.json(sdgToApi((await (await getCollection("Sdg")).findOne({ _id: id }))!));
}
