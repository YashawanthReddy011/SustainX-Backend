import type { Request, Response, NextFunction } from "express";
import type { UploadApiResponse } from "cloudinary";

import { getCollection, toApiDocument } from "../config/db";
import { randomUUID } from "node:crypto";
import { cloudinary, isCloudinaryConfigured } from "../config/cloudinary";

function detectImageMimeType(buffer: Buffer) {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return null;
}

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
	if (!isCloudinaryConfigured) {
		return res.status(503).json({ error: "Image uploads are not configured on this server." });
	}
	if (!req.file) {
		return res.status(400).json({
			error: "Choose a JPEG, PNG, WebP, or GIF image to upload.",
		});
	}
	const actualMimeType = detectImageMimeType(req.file.buffer);
	if (!actualMimeType || actualMimeType !== req.file.mimetype) {
		return res.status(400).json({ error: "The uploaded file is not a valid JPEG, PNG, WebP, or GIF image." });
	}

	let uploaded: UploadApiResponse | undefined;
	try {
		uploaded = await uploadImage(req.file.buffer);
		const document = {
			_id: randomUUID(),
			userId: req.user!.id,
			url: uploaded.secure_url,
			publicId: uploaded.public_id,
			fileName: req.file.originalname,
			mimeType: actualMimeType,
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
