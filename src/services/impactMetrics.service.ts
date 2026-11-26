export function publishedProjectFilter() {
	return {
		status: { $in: ["PUBLISHED", "ACTIVE", "COMPLETED"] },
		visibility: { $ne: "PRIVATE" },
		isPublished: { $ne: false },
		deletedAt: { $exists: false },
		isDeleted: { $ne: true },
		isDemo: { $ne: true },
	};
}

export function activeChallengeFilter(now = new Date()) {
	const startDate = { $convert: { input: { $ifNull: ["$startDate", "$createdAt"] }, to: "date", onError: null, onNull: null } };
	const endDate = { $convert: { input: { $ifNull: ["$endDate", "$deadline"] }, to: "date", onError: null, onNull: null } };
	const calculatedEndDate = {
		$dateAdd: {
			startDate,
			unit: "day",
			amount: { $convert: { input: { $ifNull: ["$durationDays", 0] }, to: "int", onError: 0, onNull: 0 } },
		},
	};
	return {
		status: "ACTIVE",
		isDemo: { $ne: true },
		deletedAt: { $exists: false },
		isDeleted: { $ne: true },
		$expr: {
			$and: [
				{ $lte: [startDate, now] },
				{ $gte: [{ $ifNull: [endDate, calculatedEndDate] }, now] },
			],
		},
	};
}
