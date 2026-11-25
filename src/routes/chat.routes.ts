import { Router } from "express";
import { z } from "zod";
import { auth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { blockUser, getBlockedUsers, getConversations, getMessages, getMessagesByConversation, getModerationReports, moderateReport, openChallengeChat, openCommunityChat, openProjectChat, readConversation, reportMessage, searchMessages, searchUsers, sendMessageHttp, startDirectConversation, startGroupConversation, unblockUser, unreadChatCount } from "../controllers/chat.controller";

const router = Router();
const idSchema = z.string().trim().min(1).max(120);

router.use(auth);
router.get("/conversations", getConversations);
router.get("/messages", getMessagesByConversation);
router.post("/messages", validate(z.object({ conversationId: idSchema, content: z.string().max(1000), attachmentUrl: z.string().url().optional() })), sendMessageHttp);
router.post("/direct", validate(z.object({ userId: idSchema })), startDirectConversation);
router.post("/groups", validate(z.object({ title: z.string().trim().min(2).max(100), memberEmails: z.array(z.string().trim().email().max(254)).max(49).default([]) })), startGroupConversation);
router.post("/community/open", openCommunityChat);
router.post("/projects/:projectId/open", openProjectChat);
router.post("/challenges/:challengeId/open", openChallengeChat);
router.get("/users", searchUsers);
router.get("/blocks", getBlockedUsers);
router.post("/users/:userId/block", blockUser);
router.delete("/users/:userId/block", unblockUser);
router.get("/notifications/unread-count", unreadChatCount);
router.get("/conversations/:id/messages/search", searchMessages);
router.get("/conversations/:id/messages", getMessages);
router.post("/conversations/:id/read", validate(z.object({ messageId: idSchema })), readConversation);
router.post("/messages/:messageId/report", validate(z.object({ reason: z.string().trim().min(5).max(1000) })), reportMessage);
router.get("/admin/reports", requireRole("ADMIN"), getModerationReports);
router.patch("/admin/reports/:reportId", requireRole("ADMIN"), validate(z.object({ action: z.enum(["DISMISS", "REMOVE_MESSAGE"]), note: z.string().max(1000).optional() })), moderateReport);

export default router;
