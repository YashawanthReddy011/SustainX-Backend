import { randomUUID } from "node:crypto";
import { getCollection, toApiDocument } from "../config/db";
import type { Role } from "../types";

export type ChatKind = "DIRECT" | "GROUP" | "COMMUNITY" | "PROJECT" | "CHALLENGE";

export class ChatServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ChatServiceError";
  }
}

const memberId = (conversationId: string, userId: string) => `${conversationId}:${userId}`;
const roomId = (conversationId: string) => `conversation:${conversationId}`;
const duplicateKey = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === 11000;

export async function ensureChatIndexes() {
  await (await getCollection("Conversation")).createIndex({ directKey: 1 }, { unique: true, sparse: true, name: "chat_direct_unique" });
  await (await getCollection("Conversation")).createIndex({ contextKey: 1 }, { unique: true, sparse: true, name: "chat_context_unique" });
  await (await getCollection("ConversationMember")).createIndex({ conversationId: 1, userId: 1 }, { unique: true, name: "chat_member_unique" });
  await (await getCollection("ConversationMember")).createIndex({ userId: 1, joinedAt: -1 }, { name: "chat_member_user" });
  await (await getCollection("Message")).createIndex({ conversationId: 1, createdAt: -1, _id: -1 }, { name: "chat_message_history" });
  await (await getCollection("MessageReport")).createIndex({ messageId: 1, reporterId: 1 }, { unique: true, name: "chat_reporter_unique" });
  await (await getCollection("UserBlock")).createIndex({ blockerId: 1, blockedId: 1 }, { unique: true, name: "chat_block_unique" });
  await (await getCollection("Notification")).createIndex({ userId: 1, read: 1, createdAt: -1 }, { name: "notification_unread" });
  await (await getCollection("ChatRateLimit")).createIndex({ resetAt: 1 }, { expireAfterSeconds: 0, name: "chat_rate_limit_ttl" });
}

export async function consumeChatMessageRateLimit(userId: string, maxMessages: number, windowMs: number) {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);
  const resetCondition = { $or: [{ $eq: [{ $type: "$resetAt" }, "missing"] }, { $lte: ["$resetAt", now] }] };
  const pipeline = [{ $set: {
    count: { $cond: [resetCondition, 1, { $add: [{ $ifNull: ["$count", 0] }, 1] }] },
    resetAt: { $cond: [resetCondition, resetAt, "$resetAt"] },
  } }];
  const collection = await getCollection("ChatRateLimit");
  let bucket: any;
  try {
    bucket = await collection.findOneAndUpdate({ _id: userId }, pipeline, { upsert: true, returnDocument: "after", includeResultMetadata: false });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error;
    bucket = await collection.findOneAndUpdate({ _id: userId }, pipeline, { returnDocument: "after", includeResultMetadata: false });
  }
  const remainingMs = Math.max(0, new Date(bucket?.resetAt ?? resetAt).getTime() - Date.now());
  return { allowed: Number(bucket?.count ?? 0) <= maxMessages, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
}

async function addMember(conversationId: string, userId: string) {
  const _id = memberId(conversationId, userId);
  await (await getCollection("ConversationMember")).updateOne(
    { _id },
    { $setOnInsert: { _id, conversationId, userId, joinedAt: new Date(), lastReadAt: null, muted: false } },
    { upsert: true }
  );
}

async function authorizeContext(kind: "PROJECT" | "CHALLENGE", contextId: string, userId: string): Promise<{ title: string; ids: string[] }> {
  if (kind === "PROJECT") {
    const project = await (await getCollection("Project")).findOne({ _id: contextId });
    if (!project) throw new ChatServiceError(404, "Project not found.");
    const members = Array.isArray(project.memberIds) ? project.memberIds : [];
    const allowed = project.ownerId === userId || members.includes(userId);
    if (!allowed) throw new ChatServiceError(403, "Join this project before opening its chat.");
    const ids: string[] = [...new Set([project.ownerId, ...members].filter((id: unknown): id is string => typeof id === "string"))];
    return { title: project.title, ids };
  }

  const challenge = await (await getCollection("Challenge")).findOne({ _id: contextId });
  if (!challenge) throw new ChatServiceError(404, "Challenge not found.");
  const members = Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds : [];
  if (!members.includes(userId)) throw new ChatServiceError(403, "Join this challenge before opening its discussion.");
  const ids = [...new Set<string>((members as unknown[]).filter((id): id is string => typeof id === "string"))];
  return { title: challenge.title, ids };
}

export async function openCommunityConversation(userId: string) {
  const conversations = await getCollection("Conversation");
  let conversation = await conversations.findOne({ contextKey: "COMMUNITY:global" });
  if (!conversation) {
    const created = { _id: randomUUID(), type: "COMMUNITY", title: "SustainX Community", contextKey: "COMMUNITY:global", createdBy: userId, createdAt: new Date(), updatedAt: new Date() };
    try {
      await conversations.insertOne(created);
      conversation = created;
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      conversation = await conversations.findOne({ contextKey: "COMMUNITY:global" });
    }
  }
  if (!conversation) throw new ChatServiceError(500, "Unable to open community chat.");
  await addMember(String(conversation._id), userId);
  return toApiDocument(conversation);
}

export async function openContextConversation(kind: "PROJECT" | "CHALLENGE", contextId: string, userId: string) {
  const context = await authorizeContext(kind, contextId, userId);
  const conversations = await getCollection("Conversation");
  const contextKey = `${kind}:${contextId}`;
  let conversation = await conversations.findOne({ contextKey });
  if (!conversation) {
    const created = { _id: randomUUID(), type: kind, title: context.title, contextId, contextKey, createdBy: userId, createdAt: new Date(), updatedAt: new Date() };
    try {
      await conversations.insertOne(created);
      conversation = created;
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      conversation = await conversations.findOne({ contextKey });
    }
  }
  if (!conversation) throw new ChatServiceError(500, "Unable to open this discussion.");
  for (const id of context.ids) await addMember(String(conversation._id), id);
  return toApiDocument(conversation);
}

async function getUserRole(userId: string): Promise<Role | null> {
  const user = await (await getCollection("User")).findOne({ _id: userId, status: "ACTIVE", emailVerified: true }, { projection: { role: 1 } });
  return user && ["STUDENT", "COMMUNITY", "ADMIN"].includes(user.role) ? user.role as Role : null;
}

export async function createDirectConversation(userId: string, otherUserId: string) {
  if (!otherUserId || otherUserId === userId) throw new ChatServiceError(400, "Choose another user to start a chat.");
  const otherRole = await getUserRole(otherUserId);
  if (!otherRole) throw new ChatServiceError(404, "User not found.");
  if (await isBlockedEitherWay(userId, otherUserId)) throw new ChatServiceError(403, "A direct conversation is unavailable because of a block.");

  const members = [userId, otherUserId].sort();
  const directKey = members.join("|");
  const conversations = await getCollection("Conversation");
  let conversation = await conversations.findOne({ directKey });
  if (!conversation) {
    const created = { _id: randomUUID(), type: "DIRECT", directKey, title: "", createdBy: userId, createdAt: new Date(), updatedAt: new Date() };
    try {
      await conversations.insertOne(created);
      conversation = created;
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      conversation = await conversations.findOne({ directKey });
    }
  }
  if (!conversation) throw new ChatServiceError(500, "Unable to create this conversation.");
  for (const id of members) await addMember(String(conversation._id), id);
  return toApiDocument(conversation);
}

export async function createGroupConversation(userId: string, title: string, memberEmails: string[]) {
  const uniqueEmails = [...new Set(memberEmails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const users = await getCollection("User");
  const invitees = uniqueEmails.length ? await users.find({ email: { $in: uniqueEmails }, status: "ACTIVE", emailVerified: true }, { projection: { _id: 1 } }).toArray() : [];
  if (invitees.length !== uniqueEmails.length) throw new ChatServiceError(400, "One or more invited accounts were not found or are not verified.");
  const memberIds = [...new Set([userId, ...invitees.map((user) => String(user._id))])];
  if (memberIds.length > 50) throw new ChatServiceError(400, "A group can have up to 50 members.");

  const conversation = { _id: randomUUID(), type: "GROUP", title: title.trim(), createdBy: userId, createdAt: new Date(), updatedAt: new Date() };
  await (await getCollection("Conversation")).insertOne(conversation);
  for (const id of memberIds) await addMember(conversation._id, id);
  return toApiDocument(conversation);
}

async function validateContextMembership(conversation: any, userId: string) {
  if (conversation.type === "PROJECT") {
    const project = await (await getCollection("Project")).findOne({ _id: conversation.contextId });
    return Boolean(project && (project.ownerId === userId || (Array.isArray(project.memberIds) && project.memberIds.includes(userId))));
  }
  if (conversation.type === "CHALLENGE") {
    const challenge = await (await getCollection("Challenge")).findOne({ _id: conversation.contextId });
    return Boolean(challenge && Array.isArray(challenge.joinedUserIds) && challenge.joinedUserIds.includes(userId));
  }
  return true;
}

export async function getCurrentConversationMemberIds(conversationId: string) {
  const conversation = await (await getCollection("Conversation")).findOne({ _id: conversationId });
  if (!conversation) return [] as string[];
  let memberIds: string[];
  if (conversation.type === "PROJECT") {
    const project = await (await getCollection("Project")).findOne({ _id: conversation.contextId });
    if (!project) return [];
    memberIds = [project.ownerId, ...(Array.isArray(project.memberIds) ? project.memberIds : [])].filter((id): id is string => typeof id === "string");
  } else if (conversation.type === "CHALLENGE") {
    const challenge = await (await getCollection("Challenge")).findOne({ _id: conversation.contextId });
    if (!challenge) return [];
    memberIds = (Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds : []).filter((id: unknown): id is string => typeof id === "string");
  } else {
    const members = await (await getCollection("ConversationMember")).find({ conversationId }, { projection: { userId: 1 } }).toArray();
    memberIds = members.map((member) => String(member.userId));
  }
  const activeUsers = await (await getCollection("User")).find({ _id: { $in: [...new Set(memberIds)] }, status: "ACTIVE", emailVerified: true }, { projection: { _id: 1 } }).toArray();
  return activeUsers.map((user) => String(user._id));
}

export async function getChatPresenceRecipientIds(userId: string) {
  const currentUser = await (await getCollection("User")).findOne({ _id: userId, status: "ACTIVE", emailVerified: true }, { projection: { _id: 1 } });
  if (!currentUser) return [] as string[];
  const memberships = await (await getCollection("ConversationMember")).find({ userId }, { projection: { conversationId: 1 } }).limit(500).toArray();
  const conversationIds = [...new Set(memberships.map((item) => String(item.conversationId)))];
  if (!conversationIds.length) return [] as string[];
  const conversations = await (await getCollection("Conversation")).find({ _id: { $in: conversationIds } }).toArray();
  const recipients = new Set<string>();
  const ordinaryIds = conversations.filter((item) => !["PROJECT", "CHALLENGE"].includes(item.type)).map((item) => String(item._id));
  if (ordinaryIds.length) {
    const members = await (await getCollection("ConversationMember")).find({ conversationId: { $in: ordinaryIds }, userId: { $ne: userId } }, { projection: { userId: 1 } }).toArray();
    for (const member of members) recipients.add(String(member.userId));
  }
  const projectConversations = conversations.filter((item) => item.type === "PROJECT");
  const projectIds = [...new Set(projectConversations.map((item) => String(item.contextId)))];
  if (projectIds.length) {
    const projects = await (await getCollection("Project")).find({ _id: { $in: projectIds } }).toArray();
    const projectById = new Map(projects.map((item) => [String(item._id), item]));
    for (const conversation of projectConversations) {
      const project = projectById.get(String(conversation.contextId));
      if (!project) continue;
      const members = [project.ownerId, ...(Array.isArray(project.memberIds) ? project.memberIds : [])].filter((id): id is string => typeof id === "string");
      if (members.includes(userId)) for (const id of members) if (id !== userId) recipients.add(id);
    }
  }
  const challengeConversations = conversations.filter((item) => item.type === "CHALLENGE");
  const challengeIds = [...new Set(challengeConversations.map((item) => String(item.contextId)))];
  if (challengeIds.length) {
    const challenges = await (await getCollection("Challenge")).find({ _id: { $in: challengeIds } }).toArray();
    const challengeById = new Map(challenges.map((item) => [String(item._id), item]));
    for (const conversation of challengeConversations) {
      const challenge = challengeById.get(String(conversation.contextId));
      if (!challenge) continue;
      const members = (Array.isArray(challenge.joinedUserIds) ? challenge.joinedUserIds : []).filter((id: unknown): id is string => typeof id === "string");
      if (members.includes(userId)) for (const id of members) if (id !== userId) recipients.add(id);
    }
  }
  const blocks = recipients.size ? await (await getCollection("UserBlock")).find({ $or: [{ blockerId: userId, blockedId: { $in: [...recipients] } }, { blockedId: userId, blockerId: { $in: [...recipients] } }] }, { projection: { blockerId: 1, blockedId: 1 } }).toArray() : [];
  const blockedIds = new Set(blocks.flatMap((block) => [String(block.blockerId), String(block.blockedId)]).filter((id) => id !== userId));
  const allowedRecipients = [...recipients].filter((id) => !blockedIds.has(id));
  const activeUsers = await (await getCollection("User")).find({ _id: { $in: allowedRecipients }, status: "ACTIVE", emailVerified: true }, { projection: { _id: 1 } }).toArray();
  return activeUsers.map((user) => String(user._id));
}

export async function assertConversationMember(userId: string, conversationId: string) {
  const conversation = await (await getCollection("Conversation")).findOne({ _id: conversationId });
  if (!conversation) throw new ChatServiceError(404, "Conversation not found.");
  const member = await (await getCollection("ConversationMember")).findOne({ conversationId, userId });
  if (!member || !(await validateContextMembership(conversation, userId))) throw new ChatServiceError(403, "You are not a member of this conversation.");
  return { conversation, member };
}

async function isBlockedEitherWay(firstUserId: string, secondUserId: string) {
  return Boolean(await (await getCollection("UserBlock")).findOne({ $or: [{ blockerId: firstUserId, blockedId: secondUserId }, { blockerId: secondUserId, blockedId: firstUserId }] }));
}

async function getBlockedParticipants(userId: string) {
  const blocks = await (await getCollection("UserBlock")).find({ $or: [{ blockerId: userId }, { blockedId: userId }] }).toArray();
  return new Set(blocks.flatMap((block) => [String(block.blockerId), String(block.blockedId)]).filter((id) => id !== userId));
}

export async function listChatUsers(userId: string, query: string) {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const users = await (await getCollection("User")).find(
    { _id: { $ne: userId }, status: "ACTIVE", emailVerified: true, $or: [{ name: { $regex: escaped, $options: "i" } }, { email: { $regex: escaped, $options: "i" } }] },
    { projection: { name: 1, email: 1, role: 1 } }
  ).limit(20).toArray();
  const blocks = await (await getCollection("UserBlock")).find({ $or: [{ blockerId: userId }, { blockedId: userId }] }).toArray();
  const blockedIds = new Set(blocks.flatMap((item) => [String(item.blockerId), String(item.blockedId)]).filter((id) => id !== userId));
  return users.filter((user) => !blockedIds.has(String(user._id))).map((user) => ({ id: String(user._id), name: user.name, email: user.email, role: user.role }));
}

export async function listConversations(userId: string, skip = 0, limit = 100) {
  const memberships = await (await getCollection("ConversationMember")).find({ userId }).sort({ joinedAt: -1 }).skip(skip).limit(limit).toArray();
  const ids = memberships.map((item) => item.conversationId);
  if (!ids.length) return [];
  const [conversations, allMembers] = await Promise.all([
    (await getCollection("Conversation")).find({ _id: { $in: ids } }).toArray(),
    (await getCollection("ConversationMember")).find({ conversationId: { $in: ids } }).toArray(),
  ]);
  const membersByConversation = new Map<string, any[]>();
  for (const item of allMembers) membersByConversation.set(item.conversationId, [...(membersByConversation.get(item.conversationId) ?? []), item]);
  const users = await (await getCollection("User")).find({ _id: { $in: [...new Set(allMembers.map((item) => item.userId))] } }, { projection: { name: 1, role: 1 } }).toArray();
  const userById = new Map(users.map((item) => [String(item._id), item]));
  const memberByConversation = new Map(memberships.map((item) => [item.conversationId, item]));
  const blocked = await getBlockedParticipants(userId);
  const rows = await Promise.all(conversations.map(async (conversation) => {
    const membership = memberByConversation.get(String(conversation._id));
    if (!membership) return null;
    if ((conversation.type === "PROJECT" || conversation.type === "CHALLENGE") && !(await validateContextMembership(conversation, userId))) return null;
    const members = membersByConversation.get(String(conversation._id)) ?? [];
    if (conversation.type === "DIRECT" && members.some((item) => item.userId !== userId && blocked.has(String(item.userId)))) return null;
    const lastMessage = await (await getCollection("Message")).find({ conversationId: String(conversation._id), moderationStatus: { $ne: "REMOVED" } }).sort({ createdAt: -1, _id: -1 }).limit(1).next();
    const unreadQuery: Record<string, unknown> = { conversationId: String(conversation._id), userId: { $nin: [userId, ...blocked] }, moderationStatus: { $ne: "REMOVED" } };
    if (membership.lastReadAt) unreadQuery.createdAt = { $gt: membership.lastReadAt };
    const unreadCount = await (await getCollection("Message")).countDocuments(unreadQuery);
    return {
      ...toApiDocument(conversation),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastActivityAt: lastMessage?.createdAt ?? conversation.updatedAt ?? conversation.createdAt,
      lastMessage: lastMessage && blocked.has(String(lastMessage.userId)) ? null : lastMessage ? toChatMessage(lastMessage, userById.get(String(lastMessage.userId))) : null,
      unreadCount,
      members: members.map((item) => ({ id: String(item.userId), name: userById.get(String(item.userId))?.name ?? "SustainX member", role: userById.get(String(item.userId))?.role ?? "STUDENT" })),
      otherUserId: conversation.type === "DIRECT" ? members.find((item) => item.userId !== userId)?.userId : undefined,
    };
  }));
  return rows.filter(Boolean).sort((a, b) => new Date(b!.lastActivityAt).getTime() - new Date(a!.lastActivityAt).getTime());
}

function toChatMessage(message: any, author?: any, readBy: string[] = []) {
  return {
    id: String(message._id),
    conversationId: String(message.conversationId),
    content: message.content ?? "",
    attachmentUrl: message.attachmentUrl,
    attachmentType: message.attachmentType,
    createdAt: message.createdAt,
    author: { id: String(message.userId), name: author?.name ?? "SustainX member", role: author?.role ?? "STUDENT" },
    readBy,
  };
}

function encodeCursor(message: any) {
  return Buffer.from(`${new Date(message.createdAt).toISOString()}|${message._id}`).toString("base64url");
}

function decodeCursor(cursor: string) {
  try {
    const [date, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|", 2);
    const createdAt = new Date(date);
    if (!id || Number.isNaN(createdAt.getTime())) throw new Error("invalid cursor");
    return { createdAt, id };
  } catch {
    throw new ChatServiceError(400, "Invalid message cursor.");
  }
}

function blockedFilter(blockedIds: Set<string>) {
  return blockedIds.size ? { userId: { $nin: [...blockedIds] } } : {};
}

export async function getConversationMessages(userId: string, conversationId: string, cursor: string | undefined, limit: number) {
  await assertConversationMember(userId, conversationId);
  const blocked = await getBlockedParticipants(userId);
  const filter: Record<string, unknown> = { conversationId, moderationStatus: { $ne: "REMOVED" }, ...blockedFilter(blocked) };
  if (cursor) {
    const before = decodeCursor(cursor);
    filter.$or = [{ createdAt: { $lt: before.createdAt } }, { createdAt: before.createdAt, _id: { $lt: before.id } }];
  }
  const rows = await (await getCollection("Message")).find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore && page.length ? encodeCursor(page[page.length - 1]) : null;
  page.reverse();
  const members = await (await getCollection("ConversationMember")).find({ conversationId }).toArray();
  const users = await (await getCollection("User")).find({ _id: { $in: [...new Set([...page.map((item) => String(item.userId)), ...members.map((item) => String(item.userId))])] } }, { projection: { name: 1, role: 1 } }).toArray();
  const usersById = new Map(users.map((item) => [String(item._id), item]));
  const messages = page.map((item) => {
    const readBy = members.filter((member) => member.userId !== item.userId && member.lastReadAt && new Date(member.lastReadAt) >= new Date(item.createdAt)).map((member) => String(member.userId));
    return toChatMessage(item, usersById.get(String(item.userId)), readBy);
  });
  return { messages, nextCursor, hasMore };
}

export async function searchConversationMessages(userId: string, conversationId: string, query: string) {
  await assertConversationMember(userId, conversationId);
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocked = await getBlockedParticipants(userId);
  const filter = { conversationId, moderationStatus: { $ne: "REMOVED" }, content: { $regex: escaped, $options: "i" }, ...blockedFilter(blocked) };
  const rows = await (await getCollection("Message")).find(filter).sort({ createdAt: -1 }).limit(50).toArray();
  const users = await (await getCollection("User")).find({ _id: { $in: [...new Set(rows.map((item) => String(item.userId)))] } }, { projection: { name: 1, role: 1 } }).toArray();
  const byId = new Map(users.map((item) => [String(item._id), item]));
  return rows.reverse().map((item) => toChatMessage(item, byId.get(String(item.userId))));
}

export async function sendConversationMessage(userId: string, conversationId: string, contentInput: string, attachmentUrl?: string) {
  const { conversation } = await assertConversationMember(userId, conversationId);
  const content = contentInput.trim();
  if (!content && !attachmentUrl) throw new ChatServiceError(400, "Write a message or attach an image.");
  if (content.length > 1000) throw new ChatServiceError(400, "Messages can contain up to 1000 characters.");

  const currentMemberIds = await getCurrentConversationMemberIds(conversationId);
  if (!currentMemberIds.includes(userId)) throw new ChatServiceError(403, "You are no longer a member of this conversation.");
  if (conversation.type === "PROJECT" || conversation.type === "CHALLENGE") {
    for (const memberId of currentMemberIds) await addMember(conversationId, memberId);
  }
  const memberRows = await (await getCollection("ConversationMember")).find({ conversationId }).toArray();
  const otherIds = currentMemberIds.filter((id) => id !== userId);
  if (conversation.type === "DIRECT" && otherIds.length && await isBlockedEitherWay(userId, otherIds[0])) throw new ChatServiceError(403, "This conversation is blocked.");

  if (attachmentUrl) {
    const media = await (await getCollection("Media")).findOne({ url: attachmentUrl, userId, mimeType: { $in: ["image/jpeg", "image/png", "image/webp", "image/gif"] } }, { projection: { _id: 1 } });
    if (!media) throw new ChatServiceError(400, "Upload an image using the chat attachment button first.");
  }

  const user = await (await getCollection("User")).findOne({ _id: userId, status: "ACTIVE", emailVerified: true }, { projection: { name: 1, role: 1 } });
  if (!user) throw new ChatServiceError(401, "User not found.");
  const message = {
    _id: randomUUID(), conversationId, userId, content,
    ...(attachmentUrl ? { attachmentUrl, attachmentType: "IMAGE" } : {}),
    moderationStatus: "VISIBLE", createdAt: new Date(),
  };
  await (await getCollection("Message")).insertOne(message);
  await (await getCollection("Conversation")).updateOne({ _id: conversationId }, { $set: { lastMessageAt: message.createdAt, updatedAt: message.createdAt } });

  const targetIds = otherIds.filter(Boolean);
  const [blockedByRecipients, blockedBySender] = await Promise.all([
    targetIds.length ? (await getCollection("UserBlock")).find({ blockerId: { $in: targetIds }, blockedId: userId }).toArray() : Promise.resolve([]),
    targetIds.length ? getBlockedParticipants(userId) : Promise.resolve(new Set<string>()),
  ]);
  const hiddenFrom = new Set([...blockedByRecipients.map((item) => String(item.blockerId)), ...blockedBySender]);
  const memberByUserId = new Map(memberRows.map((member) => [String(member.userId), member]));
  const notificationTargets = currentMemberIds.filter((id) => id !== userId && !memberByUserId.get(id)?.muted && !hiddenFrom.has(id));
  if (notificationTargets.length) {
    await (await getCollection("Notification")).insertMany(notificationTargets.map((recipientId) => ({
      _id: randomUUID(), userId: recipientId, title: conversation.title || user.name || "New message",
      message: content ? `${user.name}: ${content.slice(0, 140)}` : `${user.name} shared an image.`,
      conversationId, chatMessageId: message._id, createdAt: message.createdAt, read: false,
    })));
  }

  return {
    message: toChatMessage(message, user),
    recipientIds: notificationTargets,
    deliveryRecipientIds: currentMemberIds.filter((id) => !hiddenFrom.has(id)),
  };
}

export async function markConversationRead(userId: string, conversationId: string, messageId: string) {
  await assertConversationMember(userId, conversationId);
  const message = await (await getCollection("Message")).findOne({ _id: messageId, conversationId, moderationStatus: { $ne: "REMOVED" } }, { projection: { _id: 1, createdAt: 1 } });
  if (!message) throw new ChatServiceError(404, "Message not found in this conversation.");
  const readAt = new Date();
  await (await getCollection("ConversationMember")).updateOne({ conversationId, userId }, { $set: { lastReadMessageId: messageId, lastReadAt: readAt } });
  await (await getCollection("Notification")).updateMany({ userId, conversationId, read: false }, { $set: { read: true, readAt } });
  return { conversationId, userId, messageId, readAt };
}

export async function getUnreadChatCount(userId: string) {
  return (await getCollection("Notification")).countDocuments({ userId, read: false, conversationId: { $exists: true } });
}

export async function blockChatUser(userId: string, blockedId: string) {
  if (!blockedId || blockedId === userId) throw new ChatServiceError(400, "You cannot block this user.");
  const target = await getCollection("User");
  if (!(await target.findOne({ _id: blockedId, status: "ACTIVE" }, { projection: { _id: 1 } }))) throw new ChatServiceError(404, "User not found.");
  const _id = `${userId}:${blockedId}`;
  await (await getCollection("UserBlock")).updateOne({ _id }, { $setOnInsert: { _id, blockerId: userId, blockedId, createdAt: new Date() } }, { upsert: true });
  return { blockedId };
}

export async function unblockChatUser(userId: string, blockedId: string) {
  await (await getCollection("UserBlock")).deleteOne({ blockerId: userId, blockedId });
}

export async function listBlockedChatUsers(userId: string) {
  const blocks = await (await getCollection("UserBlock")).find({ blockerId: userId }).toArray();
  const users = await (await getCollection("User")).find({ _id: { $in: blocks.map((item) => item.blockedId) } }, { projection: { name: 1, email: 1 } }).toArray();
  const userById = new Map(users.map((item) => [String(item._id), item]));
  return blocks.map((item) => ({ id: String(item.blockedId), name: userById.get(String(item.blockedId))?.name ?? "SustainX member", email: userById.get(String(item.blockedId))?.email ?? "", blockedAt: item.createdAt }));
}

export async function reportChatMessage(reporterId: string, messageId: string, reason: string) {
  const message = await (await getCollection("Message")).findOne({ _id: messageId, moderationStatus: { $ne: "REMOVED" } });
  if (!message) throw new ChatServiceError(404, "Message not found.");
  await assertConversationMember(reporterId, String(message.conversationId));
  if (message.userId === reporterId) throw new ChatServiceError(400, "You cannot report your own message.");
  const _id = randomUUID();
  try {
    await (await getCollection("MessageReport")).insertOne({ _id, messageId, conversationId: message.conversationId, reporterId, reason: reason.trim(), status: "OPEN", createdAt: new Date() });
  } catch (error) {
    if (duplicateKey(error)) throw new ChatServiceError(409, "You already reported this message.");
    throw error;
  }
  return { id: _id, status: "OPEN" };
}

export async function listChatModerationReports() {
  const reports = await (await getCollection("MessageReport")).find({ status: "OPEN" }).sort({ createdAt: -1 }).limit(100).toArray();
  const result = [];
  for (const report of reports) {
    const [message, reporter] = await Promise.all([
      (await getCollection("Message")).findOne({ _id: report.messageId }),
      (await getCollection("User")).findOne({ _id: report.reporterId }, { projection: { name: 1, email: 1 } }),
    ]);
    const author = message ? await (await getCollection("User")).findOne({ _id: message.userId }, { projection: { name: 1, email: 1 } }) : null;
    const conversation = await (await getCollection("Conversation")).findOne({ _id: report.conversationId }, { projection: { title: 1, type: 1 } });
    result.push({ id: String(report._id), messageId: String(report.messageId), conversationId: String(report.conversationId), reason: report.reason, createdAt: report.createdAt, reporter: { id: String(report.reporterId), name: reporter?.name ?? "Unknown", email: reporter?.email ?? "" }, author: { id: String(message?.userId ?? ""), name: author?.name ?? "Unknown", email: author?.email ?? "" }, content: message?.content ?? "[message unavailable]", attachmentUrl: message?.attachmentUrl, conversation: conversation?.title || conversation?.type || "Chat" });
  }
  return result;
}

export async function moderateChatReport(reportId: string, moderatorId: string, action: "DISMISS" | "REMOVE_MESSAGE", note: string) {
  const reports = await getCollection("MessageReport");
  const report = await reports.findOne({ _id: reportId, status: "OPEN" });
  if (!report) throw new ChatServiceError(404, "Open report not found.");
  const now = new Date();
  const status = action === "REMOVE_MESSAGE" ? "ACTIONED" : "DISMISSED";
  await reports.updateOne({ _id: reportId, status: "OPEN" }, { $set: { status, action, moderatorId, moderationNote: note.trim(), moderatedAt: now } });
  if (action === "REMOVE_MESSAGE") {
    await (await getCollection("Message")).updateOne({ _id: report.messageId }, { $set: { moderationStatus: "REMOVED", removedAt: now, removedBy: moderatorId } });
  }
  return { id: reportId, status, action };
}

export async function getChatRoomForSocket(userId: string, conversationId: string) {
  const { conversation } = await assertConversationMember(userId, conversationId);
  const currentMembers = await getCurrentConversationMemberIds(conversationId);
  const blocks = currentMembers.length ? await (await getCollection("UserBlock")).find({ $or: [{ blockerId: userId, blockedId: { $in: currentMembers } }, { blockedId: userId, blockerId: { $in: currentMembers } }] }, { projection: { blockerId: 1, blockedId: 1 } }).toArray() : [];
  const blockedIds = new Set(blocks.flatMap((block) => [String(block.blockerId), String(block.blockedId)]).filter((id) => id !== userId));
  const memberUserIds = currentMembers.filter((id) => !blockedIds.has(id));
  return { conversation, room: roomId(conversationId), memberUserIds };
}

export async function markSocketMessageRead(userId: string, conversationId: string, messageId: string) {
  const receipt = await markConversationRead(userId, conversationId, messageId);
  const memberUserIds = await getCurrentConversationMemberIds(conversationId);
  return { receipt, memberUserIds };
}

