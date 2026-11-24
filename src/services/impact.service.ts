import { randomUUID } from "node:crypto";
import { getCollection, getMongoClient, toApiDocument } from "../config/db";
import { calculatePoints } from "../utils/points";

export async function verifyActivity(
  activityId: string,
  reviewNote?: string
) {
  const activities = await getCollection("Activity");
  const activity = await activities.findOne({ _id: activityId });

  if (!activity) {
    throw new Error("Activity not found");
  }

  if (activity.status === "VERIFIED") {
    return activity;
  }

  const points = calculatePoints(activity.quantity);
  const client = await getMongoClient();
  const session = client.startSession();
  let result: Record<string, any> | null = null;

  try {
    await session.withTransaction(async () => {
      const current = await activities.findOne({ _id: activityId }, { session });
      if (!current) throw new Error("Activity not found");
      if (current.status === "VERIFIED") {
        result = toApiDocument(current);
        return;
      }

      const now = new Date();
      const update = await activities.updateOne(
        { _id: activityId, status: { $ne: "VERIFIED" } },
        { $set: { status: "VERIFIED", points, reviewedAt: now, reviewNote: reviewNote ?? null } },
        { session }
      );
      if (update.modifiedCount === 0) {
        const alreadyVerified = await activities.findOne({ _id: activityId }, { session });
        result = alreadyVerified ? toApiDocument(alreadyVerified) : null;
        return;
      }

      const userUpdate = await (await getCollection("User")).updateOne(
        { _id: activity.userId },
        { $inc: { impactPoints: points } },
        { session }
      );
      if (userUpdate.matchedCount === 0) throw new Error("Activity user not found");

      const certificates = await getCollection("Certificate");
      const existingCertificate = await certificates.findOne({ activityId }, { session });
      if (!existingCertificate) {
        const year = now.getUTCFullYear();
        await certificates.insertOne({
          _id: randomUUID(),
          certificateNumber: `SX-${year}-${randomUUID().slice(0, 8).toUpperCase()}`,
          userId: activity.userId,
          activityId,
          title: `${activity.title} Impact Certificate`,
          issuedAt: now,
          status: "ACTIVE",
          createdAt: now,
        }, { session });
      }

      await (await getCollection("Notification")).insertOne(
        {
          _id: randomUUID(),
          userId: activity.userId,
          title: "Activity verified",
          message: `${activity.title} was verified and ${points} impact points were added.`,
          read: false,
          createdAt: now,
        },
        { session }
      );

      const updated = await activities.findOne({ _id: activityId }, { session });
      result = updated ? toApiDocument(updated) : null;
    });
  } finally {
    await session.endSession();
  }

  return result;
}

export async function rejectActivity(
  activityId: string,
  reviewNote?: string
) {
  const activities = await getCollection("Activity");
  const update = await activities.updateOne(
    { _id: activityId },
    { $set: { status: "REJECTED", reviewedAt: new Date(), reviewNote: reviewNote ?? null } }
  );
  if (update.matchedCount === 0) throw new Error("Activity not found");
  const activity = await activities.findOne({ _id: activityId });
  return activity ? toApiDocument(activity) : null;
}
