import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { getCollection, getMongoClient, toApiDocument } from "../config/db";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";
import { recordAdminAction } from "../services/adminAudit.service";

type EnvironmentalType =
  | "TREE_PLANTATION"
  | "WATER_CONSERVATION"
  | "WASTE_REDUCTION"
  | "BIODIVERSITY";

const typeConfig: Record<EnvironmentalType, { unit: string; sdgNumbers: number[] }> = {
  TREE_PLANTATION: { unit: "trees", sdgNumbers: [13, 15] },
  WATER_CONSERVATION: { unit: "litres", sdgNumbers: [6, 7] },
  WASTE_REDUCTION: { unit: "kg", sdgNumbers: [12, 13] },
  BIODIVERSITY: { unit: "species observations", sdgNumbers: [14, 15] },
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
  const limits: Record<EnvironmentalType, number> = {
    TREE_PLANTATION: 1000,
    WATER_CONSERVATION: 1_000_000,
    WASTE_REDUCTION: 100_000,
    BIODIVERSITY: 100,
  };
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > limits[type]) {
    return res.status(400).json({ error: `Quantity must be greater than zero and no more than ${limits[type]} ${config.unit}` });
  }
  if (["TREE_PLANTATION", "BIODIVERSITY"].includes(type) && !Number.isInteger(quantity)) {
    return res.status(400).json({ error: `${config.unit} must be a whole number` });
  }
  if (!Array.isArray(req.body.evidenceUrls) || req.body.evidenceUrls.length < 1) {
    return res.status(400).json({ error: "At least one evidence image is required for verification" });
  }
  if (["WATER_CONSERVATION", "WASTE_REDUCTION"].includes(type) && String(req.body.measurementMethod ?? "").trim().length < 10) {
    return res.status(400).json({ error: "Describe how the saved or reduced quantity was measured" });
  }
  if (["TREE_PLANTATION", "WASTE_REDUCTION"].includes(type) && (!req.body.beforeImageUrl || !req.body.afterImageUrl)) {
    return res.status(400).json({ error: "Before and after images are required for this activity type" });
  }
  if (type === "BIODIVERSITY" && !String(req.body.speciesName ?? "").trim()) {
    return res.status(400).json({ error: "Provide the observed species name(s)" });
  }
  if (type === "BIODIVERSITY") {
    const species = String(req.body.speciesName).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
    if (new Set(species).size !== species.length || species.length !== quantity) {
      return res.status(400).json({ error: "Enter one unique species name per observation; the number of names must match the quantity." });
    }
  }
  if (typeof req.body.idempotencyKey !== "string" || req.body.idempotencyKey.length < 16 || req.body.idempotencyKey.length > 100) {
    return res.status(400).json({ error: "A valid submission key is required" });
  }

  const title = String(req.body.title).trim();
  const location = String(req.body.location).trim();
  const day = new Date().toISOString().slice(0, 10);
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
  const [summaryRows, verifiedSubmissions] = await Promise.all([
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
    collection.countDocuments(),
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
      litres: values.WATER_CONSERVATION ?? 0,
      wasteKg: values.WASTE_REDUCTION ?? 0,
      speciesObservations: values.BIODIVERSITY ?? 0,
      verifiedSubmissions: values.submissions ?? 0,
    };
  });
  res.json({
    totals: {
      trees: totals.get("TREE_PLANTATION") ?? 0,
      litres: totals.get("WATER_CONSERVATION") ?? 0,
      wasteKg: totals.get("WASTE_REDUCTION") ?? 0,
      speciesObservations: totals.get("BIODIVERSITY") ?? 0,
      verifiedSubmissions,
    },
    monthlyAnalytics,
    sdgNumbers: [6, 7, 12, 13, 14, 15],
  });
}

export async function listEnvironmentalSubmissions(req: Request, res: Response) {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === "string" && req.query.status !== "ALL") {
    if (!["PENDING", "VERIFIED", "REJECTED"].includes(req.query.status)) return res.status(400).json({ error: "status is not a supported EcoGuard submission status." });
    filter.status = req.query.status;
  }
  if (typeof req.query.type === "string") {
    if (!["TREE_PLANTATION", "WATER_CONSERVATION", "WASTE_REDUCTION", "BIODIVERSITY"].includes(req.query.type)) return res.status(400).json({ error: "type is not a supported EcoGuard activity." });
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
  if ("conflict" in response) return res.status(409).json({ error: "This submission has already been reviewed and cannot be counted again." });
  await recordAdminAction(req.user!.id, `ENVIRONMENTAL_${req.body.status}`, "ENVIRONMENTAL_SUBMISSION", String(req.params.id), `Environmental submission ${req.body.status.toLowerCase()}.`);
  res.json(response);
}
