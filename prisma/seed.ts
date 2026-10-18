import { PrismaClient } from "@prisma/client";
import { sdgs } from "../src/data/sdgs";

const prisma = new PrismaClient();

async function main() {
  for (const sdg of sdgs) {
    const record = {
      name: sdg.title,
      shortName: sdg.code,
      description: sdg.description ?? sdg.shortDescription,
      color: sdg.color ?? "#0f5132",
    };

    await prisma.sdg.upsert({
      where: { id: sdg.id },
      update: record,
      create: { id: sdg.id, ...record },
    });
  }

  console.log(`Seeded ${sdgs.length} SDGs.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
