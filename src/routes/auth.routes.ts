import { Router } from "express";
import { z } from "zod";

import { login, me } from "../controllers/auth.controller";
import { auth } from "../middleware/auth";
import { validate } from "../middleware/validate";

const router = Router();

router.post(
  "/login",
  validate(
    z.object({
      email: z.string().email(),
    })
  ),
  login
);

router.get("/me", auth, me);

export default router;
