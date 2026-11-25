import { getCollection } from "../config/db";

const seededFixtures = {
	User: ["demo-admin", "demo-student", "demo-community"],
	Challenge: ["green-campus-30", "water-saver", "plastic-free-week", "biodiversity-hunt"],
	Project: ["campus-tree-revival", "zero-waste-campus", "every-drop-counts", "climate-learning-lab"],
	CommunityReport: ["report-open-drainage", "report-plastic-park", "report-street-light"],
};

export async function markKnownDemoFixtures() {
	await Promise.all(Object.entries(seededFixtures).map(async ([collectionName, ids]) => {
		const collection = await getCollection(collectionName);
		await collection.updateMany({ _id: { $in: ids }, isDemo: { $ne: true } }, { $set: { isDemo: true } });
	}));
}
