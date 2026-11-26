import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { getCollection, getMongoClient, toApiDocument } from "../config/db";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";
import { recordAdminAction } from "../services/adminAudit.service";

type EnvironmentalType =
  | "TREE_PLANTATION"
  | "TREE_SURVIVAL"
  | "WATER_CONSERVATION"
  | "RENEWABLE_ENERGY"
  | "WASTE_REDUCTION"
  | "CLIMATE_ACTION"
  | "MARINE_PROTECTION"
  | "BIODIVERSITY";

const environmentalTypes: EnvironmentalType[] = ["TREE_PLANTATION", "TREE_SURVIVAL", "WATER_CONSERVATION", "RENEWABLE_ENERGY", "WASTE_REDUCTION", "CLIMATE_ACTION", "MARINE_PROTECTION", "BIODIVERSITY"];
const typeConfig: Record<EnvironmentalType, { unit: string; sdgNumbers: number[]; max: number; integer: boolean; requireMeasurement?: boolean; requireBeforeAfter?: boolean; requireSpecies?: boolean }> = {
  TREE_PLANTATION: { unit: "trees", sdgNumbers: [15], max: 1000, integer: true, requireBeforeAfter: true },
  TREE_SURVIVAL: { unit: "trees surviving", sdgNumbers: [15], max: 1000, integer: true },
  WATER_CONSERVATION: { unit: "litres", sdgNumbers: [6], max: 1_000_000, integer: false, requireMeasurement: true },
  RENEWABLE_ENERGY: { unit: "kWh", sdgNumbers: [7], max: 1_000_000, integer: false, requireMeasurement: true },
  WASTE_REDUCTION: { unit: "kg", sdgNumbers: [12], max: 100_000, integer: false, requireMeasurement: true, requireBeforeAfter: true },
  CLIMATE_ACTION: { unit: "actions", sdgNumbers: [13], max: 1000, integer: true },
  MARINE_PROTECTION: { unit: "actions", sdgNumbers: [14], max: 1000, integer: true },
  BIODIVERSITY: { unit: "species observations", sdgNumbers: [15], max: 100, integer: true, requireSpecies: true },
};

export async function ensureEnvironmentalIndexes() {
  await Promise.all([
    (await getCollection("activitySubmissions")).createIndex(
      { userId: 1, idempotencyKey: 1 },
      { unique: true, name: "unique_user_submission_key" }
    ),
    (await getCollection("activitySubmissions")).createIndex(
      { userId: 1, dedupeFingerprint: 1 },
      { unique: true, name: "unique_user_activity_day_fingerprint" }
    ),
    (await getCollection("environmentalActivities")).createIndex(
      { submissionId: 1 },
      { unique: true, name: "unique_approved_submission" }
    ),
  ]);
}

export async function createEnvironmentalSubmission(req: Request, res: Response) {
  const type = req.body.type as EnvironmentalType;
  const config = typeConfig[type];
  if (!config) return res.status(400).json({ error: "Unsupported environmental activity type" });

  const quantity = Number(req.body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > config.max) {
    return res.status(400).json({ error: `Quantity must be greater than zero and no more than ${config.max} ${config.unit}` });
  }
  if (config.integer && !Number.isInteger(quantity)) {
    return res.status(400).json({ error: `${config.unit} must be a whole number` });
  }
  const evidenceUrls = Array.isArray(req.body.evidenceUrls) ? [...new Set(req.body.evidenceUrls as string[])] : [];
  if (evidenceUrls.length < 1 || evidenceUrls.length > 4 || evidenceUrls.length !== req.body.evidenceUrls.length) {
    return res.status(400).json({ error: "At least one evidence image is required for verification" });
  }
  if (config.requireMeasurement && String(req.body.measurementMethod ?? "").trim().length < 10) {
    return res.status(400).json({ error: "Describe how the saved or reduced quantity was measured" });
  }
  if (config.requireBeforeAfter && (!req.body.beforeImageUrl || !req.body.afterImageUrl || !evidenceUrls.includes(req.body.beforeImageUrl) || !evidenceUrls.includes(req.body.afterImageUrl))) {
    return res.status(400).json({ error: "Before and after images are required for this activity type" });
  }
  if (config.requireSpecies && !String(req.body.speciesName ?? "").trim()) {
    return res.status(400).json({ error: "Provide the observed species name(s)" });
  }
  if (config.requireSpecies) {
    const species = String(req.body.speciesName).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
    if (new Set(species).size !== species.length || species.length !== quantity) {
      return res.status(400).json({ error: "Enter one unique species name per observation; the number of names must match the quantity." });
    }
  }
  const mediaCollection = await getCollection("Media");
  const ownedMedia = await mediaCollection.countDocuments({ userId: req.user!.id, url: { $in: evidenceUrls } });
  if (ownedMedia !== evidenceUrls.length) return res.status(400).json({ error: "Use evidence images uploaded through your SustainX account." });
  if (typeof req.body.idempotencyKey !== "string" || req.body.idempotencyKey.length < 16 || req.body.idempotencyKey.length > 100) {
    return res.status(400).json({ error: "A valid submission key is required" });
  }

  const title = String(req.body.title).trim();
  const location = String(req.body.location).trim();
  const activityDateValue = typeof req.body.activityDate === "string" ? req.body.activityDate : new Date().toISOString().slice(0, 10);
  const activityDate = new Date(`${activityDateValue}T00:00:00.000Z`);
  if (Number.isNaN(activityDate.getTime()) || activityDate.toISOString().slice(0, 10) !== activityDateValue || activityDateValue > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: "Activity date must be a valid date today or earlier." });
  }
  const day = activityDate.toISOString().slice(0, 10);
  const dedupeFingerprint = createHash("sha256")
    .update([req.user!.id, type, location.toLowerCase(), day].join("|"))
    .digest("hex");
  const submission = {
    _id: randomUUID(),
    userId: req.user!.id,
    idempotencyKey: req.body.idempotencyKey,
    dedupeFingerprint,
    type,
    title,
    description: String(req.body.description).trim(),
    location,
    activityDate,
    quantity,
    unit: config.unit,
    measurementMethod: req.body.measurementMethod ? String(req.body.measurementMethod).trim() : undefined,
    sdgNumbers: config.sdgNumbers,
    speciesName: type === "BIODIVERSITY" ? String(req.body.speciesName).trim() : undefined,
    evidenceUrls: req.body.evidenceUrls as string[],
    beforeImageUrl: req.body.beforeImageUrl || undefined,
    afterImageUrl: req.body.afterImageUrl || undefined,
    status: "PENDING",
    reviewNote: null,
    submittedAt: new Date(),
  };

  try {
    await (await getCollection("activitySubmissions")).insertOne(submission);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      return res.status(409).json({ error: "This submission appears to be a duplicate for this activity and location today." });
    }
    throw error;
  }
  res.status(201).json(toApiDocument(submission));
}

export async function listMyEnvironmentalSubmissions(req: Request, res: Response) {
  const filter: Record<string, unknown> = { userId: req.user!.id };
  if (typeof req.query.status === "string" && req.query.status !== "ALL") {
    if (!["PENDING", "VERIFIED", "REJECTED"].includes(req.query.status)) return res.status(400).json({ error: "status is not a supported EcoGuard submission status." });
    filter.status = req.query.status;
  }
  const collection = await getCollection("activitySubmissions");
  const pagination = getApiPagination(req);
  const query = collection.find(filter).sort({ submittedAt: -1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const submissions = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
  res.json(submissions.map(toApiDocument));
}

export async function environmentalSummary(_req: Request, res: Response) {
  const collection = await getCollection("environmentalActivities");
  const monthKeys = Array.from({ length: 12 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (11 - index));
    return { key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`, month: date.toLocaleString("en", { month: "short", timeZone: "UTC" }) };
  });
  const firstMonth = monthKeys[0].key;
  const [summaryRows, verifiedSubmissions, pendingActivities, rejectedActivities] = await Promise.all([
    collection.aggregate<any>([
      { $facet: {
        totals: [{ $group: { _id: "$type", quantity: { $sum: { $ifNull: ["$quantity", 0] } } } }],
        monthly: [
          { $group: {
            _id: {
              month: { $dateToString: { format: "%Y-%m", date: { $ifNull: ["$verifiedAt", "$createdAt"] }, timezone: "UTC", onNull: "unknown" } },
              type: "$type",
            },
            quantity: { $sum: { $ifNull: ["$quantity", 0] } },
            submissions: { $sum: 1 },
          } },
          { $match: { "_id.month": { $gte: firstMonth } } },
        ],
      } },
    ]).toArray(),
    collection.countDocuments({ type: { $in: environmentalTypes } }),
    (await getCollection("activitySubmissions")).countDocuments({ status: "PENDING", type: { $in: environmentalTypes } }),
    (await getCollection("activitySubmissions")).countDocuments({ status: "REJECTED", type: { $in: environmentalTypes } }),
  ]);
  const totals = new Map<string, number>((summaryRows[0]?.totals ?? []).map((row: any) => [String(row._id), Number(row.quantity)] as [string, number]));
  const monthly = new Map<string, Record<string, number>>();
  for (const row of summaryRows[0]?.monthly ?? []) {
    const values = monthly.get(String(row._id.month)) ?? {};
    values[String(row._id.type)] = Number(row.quantity);
    values.submissions = (values.submissions ?? 0) + Number(row.submissions);
    monthly.set(String(row._id.month), values);
  }
  const monthlyAnalytics = Array.from({ length: 12 }, (_, index) => {
    const { key, month } = monthKeys[index];
    const values = monthly.get(key) ?? {};
    return {
      month,
      trees: values.TREE_PLANTATION ?? 0,
      treeSurvival: values.TREE_SURVIVAL ?? 0,
      litres: values.WATER_CONSERVATION ?? 0,
      kwh: values.RENEWABLE_ENERGY ?? 0,
      wasteKg: values.WASTE_REDUCTION ?? 0,
      climateActions: values.CLIMATE_ACTION ?? 0,
      marineActions: values.MARINE_PROTECTION ?? 0,
      speciesObservations: values.BIODIVERSITY ?? 0,
      verifiedSubmissions: values.submissions ?? 0,
    };
  });
  const totalsByType = {
    trees: totals.get("TREE_PLANTATION") ?? 0,
    treeSurvival: totals.get("TREE_SURVIVAL") ?? 0,
    litres: totals.get("WATER_CONSERVATION") ?? 0,
    kwh: totals.get("RENEWABLE_ENERGY") ?? 0,
    wasteKg: totals.get("WASTE_REDUCTION") ?? 0,
    climateActions: totals.get("CLIMATE_ACTION") ?? 0,
    marineActions: totals.get("MARINE_PROTECTION") ?? 0,
    speciesObservations: totals.get("BIODIVERSITY") ?? 0,
    verifiedSubmissions,
  };
  res.json({
    totalActivities: verifiedSubmissions,
    verifiedActivities: verifiedSubmissions,
    pendingActivities,
    rejectedActivities,
    treePlantation: totalsByType.trees,
    treeSurvival: totalsByType.treeSurvival,
    waterSaved: totalsByType.litres,
    renewableEnergy: totalsByType.kwh,
    wasteReduced: totalsByType.wasteKg,
    climateActions: totalsByType.climateActions,
    marineActions: totalsByType.marineActions,
    biodiversityObservations: totalsByType.speciesObservations,
    environmentalSDGs: [6, 7, 12, 13, 14, 15],
    totals: {
      ...totalsByType,
    },
    monthlyAnalytics,
    sdgNumbers: [6, 7, 12, 13, 14, 15],
  });
}

export async function listEnvironmentalSubmissions(req: Request, res: Response) {
  const filter: Record<string, unknown> = { userId: { $ne: req.user!.id } };
  if (typeof req.query.status === "string" && req.query.status !== "ALL") {
    if (!["PENDING", "VERIFIED", "REJECTED"].includes(req.query.status)) return res.status(400).json({ error: "status is not a supported EcoGuard submission status." });
    filter.status = req.query.status;
  }
  if (typeof req.query.type === "string") {
    if (!environmentalTypes.includes(req.query.type as EnvironmentalType)) return res.status(400).json({ error: "type is not a supported EcoGuard activity." });
    filter.type = req.query.type;
  }
  const collection = await getCollection("activitySubmissions");
  const pagination = getApiPagination(req);
  const query = collection.find(filter).sort({ submittedAt: -1 });
  if (pagination.enabled) query.skip(pagination.skip).limit(pagination.limit);
  const items = await query.toArray();
  if (pagination.enabled) setApiPaginationTotal(req, res, await collection.countDocuments(filter));
  const users = await getCollection("User");
  const result = await Promise.all(items.map(async (item) => {
    const user = await users.findOne({ _id: item.userId }, { projection: { name: 1, email: 1 } });
    return { ...toApiDocument(item), student: user?.name ?? "Unknown", email: user?.email ?? "" };
  }));
  res.json(result);
}

export async function reviewEnvironmentalSubmission(req: Request, res: Response) {
  const submissions = await getCollection("activitySubmissions");
  const client = await getMongoClient();
  const session = client.startSession();
  let response: Record<string, unknown> | null = null;
  try {
    await session.withTransaction(async () => {
      const current = await submissions.findOne({ _id: req.params.id }, { session });
      if (!current) {
        response = null;
        return;
      }
      if (String(current.userId) === String(req.user!.id)) {
        response = { forbidden: true };
        return;
      }
      if (current.status !== "PENDING") {
        response = { conflict: true };
        return;
      }
      const now = new Date();
      const status = req.body.status as "VERIFIED" | "REJECTED";
      const reviewer = await (await getCollection("User")).findOne({ _id: req.user!.id }, { session });
      const updated = {
        ...current,
        status,
        reviewNote: String(req.body.reviewNote ?? "").trim(),
        reviewedBy: req.user!.id,
        reviewedAt: now,
      };
      await submissions.updateOne(
        { _id: req.params.id, status: "PENDING" },
        { $set: { status, reviewNote: updated.reviewNote, reviewedBy: req.user!.id, reviewedAt: now } },
        { session }
      );
      if (status === "VERIFIED") {
        await (await getCollection("environmentalActivities")).insertOne({
          _id: randomUUID(),
          submissionId: current._id,
          userId: current.userId,
          type: current.type,
          title: current.title,
          location: current.location,
          quantity: current.quantity,
          unit: current.unit,
          measurementMethod: current.measurementMethod,
          sdgNumbers: current.sdgNumbers,
          activityDate: current.activityDate,
          speciesName: current.speciesName,
          evidenceUrls: current.evidenceUrls,
          beforeImageUrl: current.beforeImageUrl,
          afterImageUrl: current.afterImageUrl,
          verifiedBy: req.user!.id,
          verifiedByName: reviewer?.name ?? "Administrator",
          verifiedAt: now,
          createdAt: current.submittedAt,
        }, { session });
      }
      await (await getCollection("Notification")).insertOne({
        _id: randomUUID(),
        userId: current.userId,
        title: status === "VERIFIED" ? "Environmental activity verified" : "Environmental activity not approved",
        message: status === "VERIFIED"
          ? `${current.quantity} ${current.unit} for "${current.title}" were verified and added to EcoGuard impact totals.`
          : `Your submission "${current.title}" was not approved. Review the moderator's note and submit a corrected report if appropriate.`,
        read: false,
        createdAt: now,
      }, { session });
      response = toApiDocument(updated) as Record<string, unknown>;
    });
  } finally {
    await session.endSession();
  }
  if (!response) return res.status(404).json({ error: "Environmental submission not found" });
  if ("forbidden" in response) return res.status(403).json({ error: "Administrators cannot review their own environmental submissions." });
  if ("conflict" in response) return res.status(409).json({ error: "This submission has already been reviewed and cannot be counted again." });
  await recordAdminAction(req.user!.id, `ENVIRONMENTAL_${req.body.status}`, "ENVIRONMENTAL_SUBMISSION", String(req.params.id), `Environmental submission ${req.body.status.toLowerCase()}.`);
  res.json(response);
}
