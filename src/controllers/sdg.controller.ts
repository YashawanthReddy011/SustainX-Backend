import {
  Request,
  Response,
} from "express";

import { getCollection, toApiDocument } from "../config/db";
import { recordAdminAction } from "../services/adminAudit.service";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";

const categoryByGoal: Record<number, string> = {
	1: "People", 2: "People", 3: "People", 4: "People", 5: "People",
	6: "Planet", 7: "Prosperity", 8: "Prosperity", 9: "Prosperity", 10: "Prosperity", 11: "Prosperity",
	12: "Planet", 13: "Planet", 14: "Planet", 15: "Planet", 16: "Peace", 17: "Partnership",
};

function sdgToApi(document: Record<string, any>) {
	const id = Number(document._id);
  return {
    id,
    code: document.shortName ?? `SDG ${id}`,
    title: document.name ?? `Sustainable Development Goal ${id}`,
    shortDescription: document.description ?? "",
    description: document.longDescription ?? document.description ?? "",
    color: document.color,
    actions: document.actions ?? [],
    targetCount: Number.isInteger(document.targetCount) ? document.targetCount : undefined,
    category: document.category ?? categoryByGoal[id],
    isActive: document.isActive !== false,
  };
}

export async function listSdgs(req: Request, res: Response) {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.category === "string" && req.query.category !== "All") {
    const categoryRanges: Record<string, { $gte: number; $lte: number }> = {
      People: { $gte: 1, $lte: 5 },
    };
    const categoryIds: Record<string, number[]> = {
			Prosperity: [7, 8, 9, 10, 11],
			Planet: [6, 12, 13, 14, 15],
			Peace: [16],
			Partnership: [17],
		};
		const range = categoryRanges[req.query.category];
		const ids = categoryIds[req.query.category];
		if (range) filter._id = range;
		else if (ids) filter._id = { $in: ids };
		else return res.status(400).json({ error: "category is not a supported SDG category." });
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search.length > 100) return res.status(400).json({ error: "search must be 100 characters or fewer." });
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const numericId = Number(search);
		filter.$or = /^\d+$/.test(search) && Number.isInteger(numericId) && numericId >= 1 && numericId <= 17
			? [{ _id: numericId }]
			: [
					{ name: { $regex: escaped, $options: "i" } },
					{ description: { $regex: escaped, $options: "i" } },
					{ category: { $regex: escaped, $options: "i" } },
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

export async function getSdgStats(_req: Request, res: Response) {
	const documents = await (await getCollection("Sdg")).find(
		{ isActive: { $ne: false } },
		{ projection: { _id: 1, category: 1, targetCount: 1 } },
	).toArray();
	const categories = new Set(documents.map((document) => document.category ?? categoryByGoal[Number(document._id)]).filter(Boolean));
	const totalTargets = documents.reduce((sum, document) => sum + (Number.isInteger(document.targetCount) ? document.targetCount : 0), 0);
	return res.json({ totalGoals: documents.length, totalPillars: categories.size, totalTargets });
}

export async function getSdg(
  req: Request,
  res: Response
) {
  const id = Number(req.params.id);
	if (!Number.isInteger(id) || id < 1 || id > 17) return res.status(400).json({ error: "SDG id must be an integer between 1 and 17." });

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
