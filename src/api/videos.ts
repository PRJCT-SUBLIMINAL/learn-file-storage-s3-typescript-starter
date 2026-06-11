import { respondWithJSON } from "./json";

import { type ApiConfig, cfg } from "../config";
import { stderr, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { mediaTypeToExt } from "./assets";

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) throw new BadRequestError("Invalid video ID");

  const token = getBearerToken(req.headers);

  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);

  const videoMetadata = getVideo(cfg.db, videoId);
  if (!videoMetadata) throw new NotFoundError("Unable to find video metadata for "+videoId);

  if (videoMetadata.userID !== userID) throw new UserForbiddenError("Unauthorized user.");

  const parsedFormData = await req.formData();

  const videoData = parsedFormData.get("video");

  if (!videoData) throw new BadRequestError("Could not find video");

  if (!(videoData instanceof File)) throw new BadRequestError("Not a file.");

  if (videoData.size > MAX_UPLOAD_SIZE) throw new BadRequestError("File size limit exceeded.")

  const mediaType = videoData.type;

  if (mediaType === "") throw new BadRequestError("Can't find media type.");

  if (mediaType !== "video/mp4") throw new BadRequestError("MIME type must be video/mp4");

  const fileExtension = mediaTypeToExt(mediaType);

  const tempPath = `/tmp/${videoId}.${fileExtension}`;

  const file = Bun.file(tempPath);

  await Bun.write(tempPath, videoData);

  const newFilePath = await processVideoForFastStart(tempPath);
  const newFile = Bun.file(newFilePath);

  try {
    const aspectRatio = await getVideoAspectRatio(tempPath);

    const key = `${aspectRatio}/${videoId}.${fileExtension}`;

    const remoteFile = cfg.s3Client.file(key);
    await remoteFile.write(newFile, {type: mediaType});

    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;

    updateVideo(cfg.db, {...videoMetadata, videoURL});
  } finally {
    await file.delete();
    await newFile.delete();
  }
  

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const subProcess = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], { stdout: "pipe", stderr: "pipe" });
  const stdoutText = await new Response(subProcess.stdout).text();
  const stderrText = await new Response(subProcess.stderr).text();

  if (await subProcess.exited !== 0) throw new BadRequestError(stderrText);

  const output = JSON.parse(stdoutText);
  const { width, height } = output.streams[0];

  if (width === Math.floor(16 * (height / 9))) {
    return "landscape";
  } else if (height === Math.floor(16 * (width / 9))) {
    return "portrait";
  } else {
    return "other";
  }
}

export async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputFilePath = inputFilePath + ".processed";
  const subProcess = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outputFilePath], { stdout: "pipe", stderr: "pipe" });
  const stderrText = await new Response(subProcess.stderr).text();

  if (await subProcess.exited !== 0) throw new BadRequestError(stderrText);

  return outputFilePath;
}