import { prisma } from "../config/db";
import { calculatePoints } from "../utils/points";

export async function verifyActivity(
  activityId: string,
  reviewNote?: string
) {
  const activity = await prisma.activity.findUnique({
    where: {
      id: activityId,
    },
  });

  if (!activity) {
    throw new Error("Activity not found");
  }

  if (activity.status === "VERIFIED") {
    return activity;
  }

  const points = calculatePoints(activity.quantity);

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.activity.update({
      where: {
        id: activityId,
      },
      data: {
        status: "VERIFIED",
        points,
        reviewedAt: new Date(),
        reviewNote,
      },
    });

    await tx.user.update({
      where: {
        id: activity.userId,
      },
      data: {
        impactPoints: {
          increment: points,
        },
      },
    });

    await tx.notification.create({
      data: {
        userId: activity.userId,
        title: "Activity verified",
        message: `${activity.title} was verified and ${points} impact points were added.`,
      },
    });

    return updated;
  });

  return result;
}

export async function rejectActivity(
  activityId: string,
  reviewNote?: string
) {
  return prisma.activity.update({
    where: {
      id: activityId,
    },
    data: {
      status: "REJECTED",
      reviewedAt: new Date(),
      reviewNote,
    },
  });
}
