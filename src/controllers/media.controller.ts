import type { Request, Response, NextFunction } from "express";
import type { UploadApiResponse } from "cloudinary";

import { getCollection, toApiDocument } from "../config/db";
import { randomUUID } from "node:crypto";
import { cloudinary } from "../config/cloudinary";

function uploadImage(buffer: Buffer): Promise<UploadApiResponse> {
	return new Promise((resolve, reject) => {
		const stream = cloudinary.uploader.upload_stream(
			{ folder: "sustainx", resource_type: "image" },
			(error, result) => {
				if (error) {
					reject(error);
					return;
				}

				if (!result) {
					reject(new Error("Cloudinary returned no upload result."));
					return;
				}

				resolve(result);
			}
		);

		stream.end(buffer);
	});
}

export async function uploadMedia(
	req: Request,
	res: Response,
	next: NextFunction
) {
	if (!req.file) {
		return res.status(400).json({
			error: "Choose a JPEG, PNG, WebP, or GIF image to upload.",
		});
	}

	let uploaded: UploadApiResponse | undefined;
	try {
		uploaded = await uploadImage(req.file.buffer);
		const document = {
			_id: randomUUID(),
			url: uploaded.secure_url,
			publicId: uploaded.public_id,
			fileName: req.file.originalname,
			mimeType: req.file.mimetype,
			createdAt: new Date(),
		};
		await (await getCollection("Media")).insertOne(document);
		const media = toApiDocument(document);

		return res.status(201).json({ media });
	} catch (error) {
		if (uploaded) {
			try {
				await cloudinary.uploader.destroy(uploaded.public_id, {
					resource_type: "image",
				});
			} catch {
				// Keep the original upload error as the response cause.
			}
		}

		return next(error);
	}
}
