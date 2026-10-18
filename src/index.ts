import "dotenv/config";
import cors from "cors";
import express from "express";
import authRoutes from "./routes/auth.routes";
import sdgRoutes from "./routes/sdg.routes";

const app = express();
const port = Number(process.env.PORT ?? 5000);
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

app.use(cors({ origin: frontendUrl }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "sustainx-backend" });
});

app.use("/api/auth", authRoutes);
app.use("/api/sdgs", sdgRoutes);

app.use((_req, res) => {
  res.status(404).json({ message: "Route not found." });
});

app.listen(port, () => {
  console.log(`SustainX backend listening on http://localhost:${port}`);
});
