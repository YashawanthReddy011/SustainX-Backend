import { Router } from "express";

import {
  getSdg,
  listSdgs,
} from "../controllers/sdg.controller";

const router = Router();

router.get("/", listSdgs);

router.get("/:id", getSdg);

export default router;
