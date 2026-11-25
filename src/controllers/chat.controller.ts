import { Request, Response } from "express";
import { ChatServiceError, blockChatUser, consumeChatMessageRateLimit, createDirectConversation, createGroupConversation, getConversationMessages, getUnreadChatCount, listBlockedChatUsers, listChatModerationReports, listChatUsers, listConversations, markConversationRead, moderateChatReport, openCommunityConversation, openContextConversation, reportChatMessage, searchConversationMessages, sendConversationMessage, unblockChatUser } from "../services/chat.service";
import { recordAdminAction } from "../services/adminAudit.service";
import { getApiPagination, setApiPaginationTotal } from "../middleware/apiV1";
import { getCollection } from "../config/db";

const routeParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? "" : value ?? "";

function handleChatError(res: Response, error: unknown) {
  if (error instanceof ChatServiceError) return res.status(error.status).json({ error: error.message });
  throw error;
}

export async function getConversations(req: Request, res: Response) {
  const pagination = getApiPagination(req);
  if (pagination.enabled) setApiPaginationTotal(req, res, await (await getCollection("ConversationMember")).countDocuments({ userId: req.user!.id }));
  return res.json(await listConversations(req.user!.id, pagination.enabled ? pagination.skip : 0, pagination.enabled ? pagination.limit : 100));
}

export async function startDirectConversation(req: Request, res: Response) {
  try { return res.status(201).json(await createDirectConversation(req.user!.id, req.body.userId)); }
  catch (error) { return handleChatError(res, error); }
}

export async function startGroupConversation(req: Request, res: Response) {
  try { return res.status(201).json(await createGroupConversation(req.user!.id, req.body.title, req.body.memberEmails)); }
  catch (error) { return handleChatError(res, error); }
}

export async function openCommunityChat(req: Request, res: Response) {
  return res.json(await openCommunityConversation(req.user!.id));
}

export async function openProjectChat(req: Request, res: Response) {
  try { return res.json(await openContextConversation("PROJECT", routeParam(req.params.projectId), req.user!.id)); }
  catch (error) { return handleChatError(res, error); }
}

export async function openChallengeChat(req: Request, res: Response) {
  try { return res.json(await openContextConversation("CHALLENGE", routeParam(req.params.challengeId), req.user!.id)); }
  catch (error) { return handleChatError(res, error); }
}

export async function getMessages(req: Request, res: Response) {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 30));
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    return res.json(await getConversationMessages(req.user!.id, routeParam(req.params.id), cursor, limit));
  } catch (error) { return handleChatError(res, error); }
}

export async function getMessagesByConversation(req: Request, res: Response) {
  const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
  if (!conversationId || conversationId.length > 120) return res.status(400).json({ error: "conversationId is required." });
  req.params.id = conversationId;
  return getMessages(req, res);
}

export async function sendMessageHttp(req: Request, res: Response) {
  const rate = await consumeChatMessageRateLimit(req.user!.id, 30, 60_000);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    return res.status(429).json({ error: `You are sending messages too quickly. Try again in ${rate.retryAfterSeconds} seconds.` });
  }
  try {
    const result = await sendConversationMessage(req.user!.id, req.body.conversationId, req.body.content, req.body.attachmentUrl);
    return res.status(201).json(result.message);
  } catch (error) { return handleChatError(res, error); }
}

export async function searchMessages(req: Request, res: Response) {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 2 || query.length > 100) return res.status(400).json({ error: "Search must be between 2 and 100 characters." });
  try { return res.json(await searchConversationMessages(req.user!.id, routeParam(req.params.id), query)); }
  catch (error) { return handleChatError(res, error); }
}

export async function readConversation(req: Request, res: Response) {
  try { return res.json(await markConversationRead(req.user!.id, routeParam(req.params.id), req.body.messageId)); }
  catch (error) { return handleChatError(res, error); }
}

export async function unreadChatCount(req: Request, res: Response) {
  return res.json({ count: await getUnreadChatCount(req.user!.id) });
}

export async function searchUsers(req: Request, res: Response) {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 2 || query.length > 100) return res.json([]);
  return res.json(await listChatUsers(req.user!.id, query));
}

export async function blockUser(req: Request, res: Response) {
  try { return res.status(201).json(await blockChatUser(req.user!.id, routeParam(req.params.userId))); }
  catch (error) { return handleChatError(res, error); }
}

export async function unblockUser(req: Request, res: Response) {
  try { await unblockChatUser(req.user!.id, routeParam(req.params.userId)); return res.status(204).send(); }
  catch (error) { return handleChatError(res, error); }
}

export async function getBlockedUsers(req: Request, res: Response) {
  return res.json(await listBlockedChatUsers(req.user!.id));
}

export async function reportMessage(req: Request, res: Response) {
  try { return res.status(201).json(await reportChatMessage(req.user!.id, routeParam(req.params.messageId), req.body.reason)); }
  catch (error) { return handleChatError(res, error); }
}

export async function getModerationReports(_req: Request, res: Response) {
  return res.json(await listChatModerationReports());
}

export async function moderateReport(req: Request, res: Response) {
  try {
    const reportId = routeParam(req.params.reportId);
    const result = await moderateChatReport(reportId, req.user!.id, req.body.action, req.body.note ?? "");
    await recordAdminAction(req.user!.id, `CHAT_REPORT_${req.body.action}`, "CHAT_REPORT", reportId, `Chat report ${req.body.action.toLowerCase()}.`);
    return res.json(result);
  }
  catch (error) { return handleChatError(res, error); }
}
