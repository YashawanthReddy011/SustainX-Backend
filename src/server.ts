import cors from "cors";
import express from "express";
import helmet from "helmet";

import { env } from "./config/env";

import activityRoutes from "./routes/activity.routes";
import authRoutes from "./routes/auth.routes";
import mediaRoutes from "./routes/media.routes";
import sdgRoutes from "./routes/sdg.routes";
import platformRoutes from "./routes/platform.routes";
import { challenges, projects, reports } from "./routes/community.routes";
import { errorHandler } from "./middleware/error";
import { closeMongoDB, connectToMongoDB } from "./config/db";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: [env.clientUrl, env.adminUrl],
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "SustainX API" });
});

app.use("/api/auth", authRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/sdgs", sdgRoutes);
app.use("/api/activities", activityRoutes);
app.use("/api/challenges", challenges);
app.use("/api/projects", projects);
app.use("/api/reports", reports);
app.use("/api", platformRoutes);

app.use(errorHandler);

async function start() {
  await connectToMongoDB();
  const server = app.listen(env.port, () => {
    console.log(`SustainX API running on http://localhost:${env.port}`);
  });

  const shutdown = () => {
    server.close(async () => {
      await closeMongoDB();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("Failed to start SustainX API:", error);
  process.exit(1);
});
