import "dotenv/config";

import cors from "cors";
import express from "express";
import helmet from "helmet";
import http from "node:http";
import { isIP } from "node:net";
import { Server as SocketServer } from "socket.io";

import { env } from "./config/env";
import { ensureAuthIndexes, resolveTokenUser } from "./middleware/auth";
import { ChatServiceError, consumeChatMessageRateLimit, ensureChatIndexes, getChatPresenceRecipientIds, getChatRoomForSocket, getCurrentConversationMemberIds, markSocketMessageRead, sendConversationMessage } from "./services/chat.service";
import { ensureAdminAuditIndex } from "./services/adminAudit.service";
import { ensureDatabaseIndexes } from "./services/databaseIndexes.service";
import { markKnownDemoFixtures } from "./services/demoFixtures.service";

import activityRoutes from "./routes/activity.routes";
import authRoutes from "./routes/auth.routes";
import mediaRoutes from "./routes/media.routes";
import sdgRoutes from "./routes/sdg.routes";
import platformRoutes from "./routes/platform.routes";
import chatRoutes from "./routes/chat.routes";
import environmentalRoutes from "./routes/environmental.routes";
import apiV1Routes from "./routes/v1.routes";
import { ensureEnvironmentalIndexes } from "./controllers/environmental.controller";
import { challenges, projects, reports } from "./routes/community.routes";
import { errorHandler } from "./middleware/error";
import { closeMongoDB, connectToMongoDB } from "./config/db";
import { requestContext } from "./middleware/requestContext";
import { logger } from "./utils/logger";

const app = express();
app.set("trust proxy", env.trustProxyHops);

const isDevelopmentLanOrigin = (origin: string): boolean => {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || !["3000", "3001"].includes(parsed.port)) return false;

    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname === "::1") return true;
    if (isIP(hostname) !== 4) return false;

    const [first, second] = hostname.split(".").map(Number);
    return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) || (first === 169 && second === 254);
  } catch {
    return false;
  }
};

const corsOrigin = (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
  const allowed = !origin || origin === env.clientUrl || origin === env.adminUrl ||
    (env.nodeEnv === "development" && isDevelopmentLanOrigin(origin));
  callback(null, allowed);
};

app.use(helmet());
app.use(requestContext);
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_req, res) => {
	try {
		await connectToMongoDB();
		res.json({ ok: true, name: "SustainX API", database: "ready" });
	} catch {
		res.status(503).json({ ok: false, name: "SustainX API", database: "unavailable" });
	}
});

app.use("/api/v1", apiV1Routes);
app.use("/api/auth", authRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/sdgs", sdgRoutes);
app.use("/api/activities", activityRoutes);
app.use("/api/challenges", challenges);
app.use("/api/projects", projects);
app.use("/api/reports", reports);
app.use("/api/chat", chatRoutes);
app.use("/api/environmental", environmentalRoutes);
app.use("/api", platformRoutes);

app.use(errorHandler);

async function start() {
  await connectToMongoDB();
  await ensureAuthIndexes();
  await ensureChatIndexes();
  await ensureAdminAuditIndex();
  await ensureEnvironmentalIndexes();
  await ensureDatabaseIndexes();
  await markKnownDemoFixtures();
  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });

  io.use((socket, next) => {
    void (async () => {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token) throw new Error("Missing token");
      const resolved = await resolveTokenUser(token);
      if (!resolved) throw new Error("Unauthorized");
      socket.data.token = token;
      socket.data.user = resolved.user;
    })().then(() => next()).catch(() => next(new Error("Unauthorized")));
  });

  const onlineSockets = new Map<string, Set<string>>();
  io.on("connection", (socket) => {
    const initialUser = socket.data.user as { id: string; role: string };
    const userId = initialUser.id;
    socket.join(`user:${userId}`);
    const sockets = onlineSockets.get(userId) ?? new Set<string>();
    sockets.add(socket.id);
    onlineSockets.set(userId, sockets);
    void getChatPresenceRecipientIds(userId).then((memberIds) => {
      const memberRooms = memberIds.map((memberId) => `user:${memberId}`);
      if (memberRooms.length) io.to(memberRooms).emit("presence:update", { userId, online: true });
    }).catch(() => undefined);

    const getCurrentUser = async () => {
      const token = socket.data.token;
      if (typeof token !== "string") throw new ChatServiceError(401, "Authentication required.");
      const resolved = await resolveTokenUser(token);
      if (!resolved) throw new ChatServiceError(401, "Your session has expired.");
      return resolved.user;
    };

    socket.on("conversation:join", (payload: unknown, acknowledge?: (result: unknown) => void) => {
      void (async () => {
        try {
          const user = await getCurrentUser();
          const conversationId = typeof payload === "object" && payload !== null ? String((payload as { conversationId?: unknown }).conversationId ?? "") : "";
          const { room, memberUserIds } = await getChatRoomForSocket(user.id, conversationId);
          await socket.join(room);
          socket.emit("presence:list", { userIds: memberUserIds.filter((memberId) => onlineSockets.has(memberId)) });
          const presenceRooms = memberUserIds.map((memberId) => `user:${memberId}`);
          if (presenceRooms.length) io.to(presenceRooms).emit("presence:update", { userId: user.id, online: true });
          acknowledge?.({ ok: true });
        } catch (error) {
          if (error instanceof ChatServiceError && error.status === 401) socket.disconnect(true);
          acknowledge?.({ ok: false, error: error instanceof Error ? error.message : "Unable to join conversation." });
        }
      })();
    });

    socket.on("conversation:leave", (payload: unknown) => {
      const conversationId = typeof payload === "object" && payload !== null ? String((payload as { conversationId?: unknown }).conversationId ?? "") : "";
      if (conversationId) void socket.leave(`conversation:${conversationId}`);
    });

    socket.on("message:send", (payload: unknown, acknowledge?: (result: unknown) => void) => {
      void (async () => {
        try {
          const user = await getCurrentUser();
          const data = typeof payload === "object" && payload !== null ? payload as { conversationId?: unknown; content?: unknown; attachmentUrl?: unknown } : {};
          const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
          const content = typeof data.content === "string" ? data.content : "";
          const attachmentUrl = typeof data.attachmentUrl === "string" ? data.attachmentUrl : undefined;
          const room = `conversation:${conversationId}`;
          if (!conversationId || !socket.rooms.has(room)) throw new ChatServiceError(403, "Join this conversation before sending a message.");

          const rate = await consumeChatMessageRateLimit(user.id, 30, 60_000);
          if (!rate.allowed) throw new ChatServiceError(429, `You are sending messages too quickly. Try again in ${rate.retryAfterSeconds} seconds.`);

          const result = await sendConversationMessage(user.id, conversationId, content, attachmentUrl);
          const deliveryRooms = result.deliveryRecipientIds.map((id) => `user:${id}`);
          if (deliveryRooms.length) io.to(deliveryRooms).emit("message:new", result.message);
          for (const recipientId of result.recipientIds) {
            io.to(`user:${recipientId}`).emit("notification:new", {
              conversationId,
              messageId: result.message.id,
              title: result.message.author.name,
              createdAt: result.message.createdAt,
            });
          }
          acknowledge?.({ ok: true, message: result.message });
        } catch (error) {
          if (error instanceof ChatServiceError && error.status === 401) socket.disconnect(true);
          acknowledge?.({ ok: false, error: error instanceof Error ? error.message : "Unable to send message." });
        }
      })();
    });

    socket.on("conversation:read", (payload: unknown, acknowledge?: (result: unknown) => void) => {
      void (async () => {
        try {
          const user = await getCurrentUser();
          const data = typeof payload === "object" && payload !== null ? payload as { conversationId?: unknown; messageId?: unknown } : {};
          const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
          const messageId = typeof data.messageId === "string" ? data.messageId : "";
          const room = `conversation:${conversationId}`;
          if (!conversationId || !messageId || !socket.rooms.has(room)) throw new ChatServiceError(403, "Join this conversation before updating read status.");
          const { receipt, memberUserIds } = await markSocketMessageRead(user.id, conversationId, messageId);
          const receiptRooms = memberUserIds.map((memberId) => `user:${memberId}`);
          if (receiptRooms.length) io.to(receiptRooms).emit("conversation:read", receipt);
          acknowledge?.({ ok: true });
        } catch (error) {
          if (error instanceof ChatServiceError && error.status === 401) socket.disconnect(true);
          acknowledge?.({ ok: false, error: error instanceof Error ? error.message : "Unable to update read status." });
        }
      })();
    });

    socket.on("disconnect", () => {
      const userSockets = onlineSockets.get(userId);
      userSockets?.delete(socket.id);
      if (userSockets?.size === 0) {
        onlineSockets.delete(userId);
        void getChatPresenceRecipientIds(userId).then((memberIds) => {
          const memberRooms = memberIds.map((memberId) => `user:${memberId}`);
          if (memberRooms.length) io.to(memberRooms).emit("presence:update", { userId, online: false });
        }).catch(() => undefined);
      }
    });
  });

  const server = httpServer.listen(env.port, () => {
    logger.info("SustainX API listening", { port: env.port, environment: env.nodeEnv });
  });

  const shutdown = () => {
    server.close(async () => {
      await closeMongoDB();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  logger.error("Failed to start SustainX API", logger.formatError(error));
  process.exit(1);
});
