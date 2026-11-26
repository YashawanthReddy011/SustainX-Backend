import { closeMongoDB, connectToMongoDB, getCollection } from "../config/db";
import { sdgs } from "../data/sdgs";

async function seedSdgs() {
	try {
		await connectToMongoDB();
		const collection = await getCollection("Sdg");

		for (const sdg of sdgs) {
			await collection.updateOne(
				{ _id: sdg.id },
				{
					$set: {
						name: sdg.title,
						shortName: sdg.code,
						description: sdg.shortDescription,
						color: sdg.color,
						number: sdg.id,
						category: sdg.category,
						targetCount: sdg.targetCount,
						isActive: true,
					},
					$unset: { targets: "" },
				},
				{ upsert: true },
			);
		}

		console.log(`Seeded ${sdgs.length} official SDGs with ${sdgs.reduce((sum, sdg) => sum + sdg.targetCount, 0)} official targets.`);
	} finally {
		await closeMongoDB();
	}
}

seedSdgs().catch((error) => {
	console.error("SDG seed failed:", error);
	process.exitCode = 1;
});
