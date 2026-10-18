import cors from "cors";
import express from "express";
import helmet from "helmet";

import { env } from "./config/env";

import activityRoutes from "./routes/activity.routes";
import authRoutes from "./routes/auth.routes";
import mediaRoutes from "./routes/media.routes";
import sdgRoutes from "./routes/sdg.routes";
import { errorHandler } from "./middleware/error";

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

app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`SustainX API running on http://localhost:${env.port}`);
});
