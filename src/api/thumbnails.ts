import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  const parsedFormData = await req.formData();
  const imageData = parsedFormData.get("thumbnail");

  if (!imageData) throw new BadRequestError("Could not find image.");

  if (!(imageData instanceof File)) throw new BadRequestError("Not a file.");

  const MAX_UPLOAD_SIZE = 10 << 20;

  if (imageData.size > MAX_UPLOAD_SIZE) throw new BadRequestError("Image exceeds max upload size.");

  const mediaType = imageData.type
  if (mediaType === "") throw new BadRequestError("Can't find media type");

  const imageArrayBuffer = await imageData.arrayBuffer();
  const imageBuffer = Buffer.from(imageArrayBuffer);
  const base64string = imageBuffer.toString("base64");

  const video = getVideo(cfg.db, videoId);
  if (!video) throw new NotFoundError("Could not find video.");

  if (video.userID !== userID) throw new UserForbiddenError("User not authorized.");

  const dataURL = `data:${mediaType};base64,${base64string}`

  video.thumbnailURL = dataURL;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
