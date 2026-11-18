
import express from "express";
import Redis from "ioredis";

// --------------------------------------------------
// 1. Application Configuration
// --------------------------------------------------

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const REDIS_URL =
  process.env.REDIS_URL || "redis://localhost:6379";

const BANNER_KEY = "app:banner";

const MAX_BANNER_LENGTH = 500;

// --------------------------------------------------
// 2. Redis Configuration
// --------------------------------------------------

const redis = new Redis(REDIS_URL, {
  connectTimeout: 10000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,

  retryStrategy(times) {
    if (times > 10) {
      console.error("Redis: Maximum reconnection attempts reached");
      return null;
    }

    const delay = Math.min(times * 500, 5000);

    console.log(`Redis reconnecting in ${delay}ms...`);

    return delay;
  },
});

redis.on("connect", () => {
  console.log("Redis: Connecting...");
});

redis.on("ready", () => {
  console.log("Redis: Connected and ready");
});

redis.on("error", (error) => {
  console.error("Redis Error:", error.message);
});

redis.on("close", () => {
  console.log("Redis: Connection closed");
});

redis.on("reconnecting", () => {
  console.log("Redis: Reconnecting...");
});

// --------------------------------------------------
// 3. Middleware
// --------------------------------------------------

app.use(express.json({ limit: "10kb" }));

// --------------------------------------------------
// 4. Async Error Handler
// --------------------------------------------------

const asyncHandler = (handler) => {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
};

// --------------------------------------------------
// 5. Health Check APIs
// --------------------------------------------------

// Application liveness
app.get("/health/live", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Application is running",
  });
});

// Redis readiness
app.get(
  "/health/ready",
  asyncHandler(async (req, res) => {
    const reply = await redis.ping();

    if (reply !== "PONG") {
      return res.status(503).json({
        success: false,
        message: "Redis is not ready",
      });
    }

    res.status(200).json({
      success: true,
      message: "Application and Redis are ready",
    });
  })
);

// --------------------------------------------------
// 6. Create / Update Banner
// --------------------------------------------------

app.post(
  "/banner",
  asyncHandler(async (req, res) => {
    const { banner } = req.body || {};

    // Validate banner
    if (typeof banner !== "string") {
      return res.status(400).json({
        success: false,
        message: "Banner must be a string",
      });
    }

    const trimmedBanner = banner.trim();

    if (!trimmedBanner) {
      return res.status(400).json({
        success: false,
        message: "Banner cannot be empty",
      });
    }

    if (trimmedBanner.length > MAX_BANNER_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Banner cannot exceed ${MAX_BANNER_LENGTH} characters`,
      });
    }

    // Save banner in Redis
    await redis.set(BANNER_KEY, trimmedBanner);

    res.status(200).json({
      success: true,
      message: "Banner updated successfully",
      data: {
        banner: trimmedBanner,
      },
    });
  })
);

// --------------------------------------------------
// 7. Get Banner
// --------------------------------------------------

app.get(
  "/banner",
  asyncHandler(async (req, res) => {
    const banner = await redis.get(BANNER_KEY);

    if (banner === null) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
        data: null,
      });
    }

    res.status(200).json({
      success: true,
      message: "Banner fetched successfully",
      data: {
        banner,
      },
    });
  })
);

// --------------------------------------------------
// 8. Delete Banner
// --------------------------------------------------

app.delete(
  "/banner",
  asyncHandler(async (req, res) => {
    const deleted = await redis.del(BANNER_KEY);

    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        message: "Banner does not exist",
      });
    }

    res.status(200).json({
      success: true,
      message: "Banner deleted successfully",
    });
  })
);

// --------------------------------------------------
// 9. Check Banner Existence
// --------------------------------------------------

app.get(
  "/banner/exist",
  asyncHandler(async (req, res) => {
    const exists = await redis.exists(BANNER_KEY);

    res.status(200).json({
      success: true,
      data: {
        exists: exists === 1,
      },
    });
  })
);

// --------------------------------------------------
// 10. Handle Unknown Routes
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// --------------------------------------------------
// 11. Global Error Handler
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Application Error:", error);

  if (res.headersSent) {
    return next(error);
  }

  // Invalid JSON
  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    "body" in error
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON request body",
    });
  }

  // Request body too large
  if (error.status === 413) {
    return res.status(413).json({
      success: false,
      message: "Request body is too large",
    });
  }

  // Redis connection or command errors
  if (
    error instanceof Redis.RedisError ||
    error.code === "ECONNREFUSED" ||
    error.code === "ETIMEDOUT"
  ) {
    return res.status(503).json({
      success: false,
      message: "Redis service is temporarily unavailable",
    });
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// --------------------------------------------------
// 12. Start Server
// --------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// --------------------------------------------------
// 13. Graceful Shutdown
// --------------------------------------------------

let isShuttingDown = false;

const shutdown = async (signal) => {
  if (isShuttingDown) return;

  isShuttingDown = true;

  console.log(`${signal} received. Shutting down...`);

  server.close(async (error) => {
    if (error) {
      console.error("HTTP server shutdown error:", error);
    }

    try {
      await redis.quit();
      console.log("Redis connection closed gracefully");
    } catch (redisError) {
      console.error("Redis shutdown error:", redisError.message);
      redis.disconnect();
    }

    process.exit(error ? 1 : 0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
