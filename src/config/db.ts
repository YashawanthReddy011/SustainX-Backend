import "dotenv/config";
import { Db, Document, MongoClient } from "mongodb";

const uri = process.env.DATABASE_URL ?? "";

if (!uri) {
  throw new Error("DATABASE_URL must be set before the API starts.");
}

const client = new MongoClient(uri);
let databasePromise: Promise<Db> | undefined;

export async function connectToMongoDB(): Promise<Db> {
  if (!databasePromise) {
    databasePromise = client.connect().then(async (connectedClient) => {
      const databaseName = process.env.MONGODB_DATABASE;
      const database = databaseName
        ? connectedClient.db(databaseName)
        : connectedClient.db(databaseNameFromUri(uri));
      await database.command({ ping: 1 });
      return database;
    });
  }

  return databasePromise;
}

function databaseNameFromUri(connectionString: string): string {
  try {
    const name = new URL(connectionString).pathname.replace(/^\/+/, "").split("/")[0];
    if (!name) return "sustainx";
    return name;
  } catch {
    return "sustainx";
  }
}

export async function getMongoClient(): Promise<MongoClient> {
  await connectToMongoDB();
  return client;
}

export async function getCollection<T extends Document = any>(
  name: string
) {
  const database = await connectToMongoDB();
  return database.collection<T>(name);
}

export async function closeMongoDB(): Promise<void> {
  if (databasePromise) {
    await client.close();
    databasePromise = undefined;
  }
}

export function toApiDocument<T extends Document>(document: T) {
  const { _id, ...fields } = document;
  return { id: _id, ...fields };
}
