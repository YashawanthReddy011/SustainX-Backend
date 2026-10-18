import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import { uploadMedia } from "../controllers/media.controller";
import { auth } from "../middleware/auth";

const allowedImageTypes = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
]);

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 5 * 1024 * 1024,
		files: 1,
	},
	fileFilter: (_req, file, callback) => {
		callback(null, allowedImageTypes.has(file.mimetype));
	},
});

function parseImageUpload(
 req: Request,
 res: Response,
 next: NextFunction
) {
	upload.single("file")(req, res, (error) => {
		if (error instanceof multer.MulterError) {
			const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
			return res.status(status).json({
				error:
					error.code === "LIMIT_FILE_SIZE"
						? "Image uploads must be 5 MB or smaller."
						: "Upload one image at a time.",
			});
		}

		if (error) {
			return res.status(400).json({ error: "Unable to process this upload." });
		}

		return next();
	});
}

const router = Router();

router.post("/", auth, parseImageUpload, uploadMedia);

export default router;
