const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

class VehicleIssueUploadError extends Error {
  constructor(message, statusCode = 400, code = "VEHICLE_ISSUE_IMAGE_INVALID") {
    super(message);
    this.name = "VehicleIssueUploadError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function localFallbackAllowed() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.VEHICLE_ISSUE_ALLOW_LOCAL_UPLOADS === "true"
  );
}

function validateImageFile(file) {
  if (!file) return null;
  if (!ALLOWED_MIME_TYPES.has(String(file.mimetype || "").toLowerCase())) {
    throw new VehicleIssueUploadError(
      "Only JPEG, PNG, and WEBP vehicle-issue images are allowed",
      400,
      "VEHICLE_ISSUE_IMAGE_TYPE_INVALID"
    );
  }
  const size = Number(file.size ?? file.buffer?.length ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new VehicleIssueUploadError(
      "The vehicle-issue image is empty",
      400,
      "VEHICLE_ISSUE_IMAGE_EMPTY"
    );
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new VehicleIssueUploadError(
      "The vehicle-issue image must not exceed 5 MB",
      413,
      "VEHICLE_ISSUE_IMAGE_TOO_LARGE"
    );
  }
  return file;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (req, file, callback) => {
    try {
      if (!ALLOWED_MIME_TYPES.has(String(file.mimetype || "").toLowerCase())) {
        return callback(
          new VehicleIssueUploadError(
            "Only JPEG, PNG, and WEBP vehicle-issue images are allowed",
            400,
            "VEHICLE_ISSUE_IMAGE_TYPE_INVALID"
          )
        );
      }
      return callback(null, true);
    } catch (error) {
      return callback(error);
    }
  }
});

function vehicleIssueImageUpload(req, res, next) {
  upload.single("image")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "The vehicle-issue image must not exceed 5 MB",
        code: "VEHICLE_ISSUE_IMAGE_TOO_LARGE"
      });
    }
    const statusCode = Number(error.statusCode) || 400;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "The vehicle-issue image could not be accepted",
      code: error.code || "VEHICLE_ISSUE_IMAGE_INVALID"
    });
  });
}

function randomImageName(file) {
  const extension = ALLOWED_MIME_TYPES.get(String(file.mimetype).toLowerCase());
  return `${Date.now()}-${crypto.randomBytes(18).toString("hex")}${extension}`;
}

async function uploadToCloudinary(file) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  const publicId = `vehicle-issues/${path.parse(randomImageName(file)).name}`;
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: "image",
        overwrite: false
      },
      (error, uploaded) => (error ? reject(error) : resolve(uploaded))
    );
    stream.end(file.buffer);
  });
  return {
    url: result.secure_url,
    storage: "cloudinary",
    publicId: result.public_id
  };
}

async function uploadToLocalDevelopmentStorage(file) {
  const directory = path.join(__dirname, "..", "uploads", "vehicle-issues");
  await fs.promises.mkdir(directory, { recursive: true });
  const fileName = randomImageName(file);
  await fs.promises.writeFile(path.join(directory, fileName), file.buffer, {
    flag: "wx"
  });
  return {
    url: `/uploads/vehicle-issues/${fileName}`,
    storage: "local-development",
    localPath: path.join(directory, fileName)
  };
}

async function storeVehicleIssueImage(file) {
  if (!file) return null;
  validateImageFile(file);
  try {
    if (cloudinaryConfigured()) return await uploadToCloudinary(file);
    if (localFallbackAllowed()) return await uploadToLocalDevelopmentStorage(file);
  } catch (error) {
    throw new VehicleIssueUploadError(
      "The vehicle-issue image could not be stored",
      503,
      "VEHICLE_ISSUE_IMAGE_STORAGE_UNAVAILABLE"
    );
  }
  throw new VehicleIssueUploadError(
    "Durable vehicle-issue image storage is not configured",
    503,
    "VEHICLE_ISSUE_DURABLE_STORAGE_REQUIRED"
  );
}

async function deleteStoredVehicleIssueImage(storedImage) {
  if (!storedImage) return;
  try {
    if (storedImage.storage === "cloudinary" && storedImage.publicId) {
      await cloudinary.uploader.destroy(storedImage.publicId, {
        resource_type: "image"
      });
    } else if (
      storedImage.storage === "local-development" &&
      storedImage.localPath
    ) {
      await fs.promises.unlink(storedImage.localPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        "[VehicleIssue] Temporary image cleanup failed:",
        error?.code || "UNKNOWN_UPLOAD_CLEANUP_ERROR"
      );
    }
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  ALLOWED_MIME_TYPES,
  VehicleIssueUploadError,
  cloudinaryConfigured,
  localFallbackAllowed,
  validateImageFile,
  vehicleIssueImageUpload,
  storeVehicleIssueImage,
  deleteStoredVehicleIssueImage
};
