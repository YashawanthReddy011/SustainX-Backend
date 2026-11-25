import { Request, Response } from "express";
import { getCollection, toApiDocument } from "../config/db";
import { canDeliverAuthEmail, passwordResetLink, sendAuthEmail, verificationLink } from "../services/authEmail.service";
import { createPasswordAccount } from "../services/account.service";
import { hashOneTimeToken, createOneTimeToken } from "../utils/oneTimeToken";
import { hashPassword, verifyPassword } from "../utils/password";
import { signToken } from "../utils/jwt";
import { revokeToken } from "../middleware/auth";
import { recordAdminAction } from "../services/adminAudit.service";
import { createLoginOtp, hashLoginOtp, loginOtpMatches, LOGIN_OTP_MAX_ATTEMPTS, LOGIN_OTP_TTL_MS } from "../utils/loginOtp";
import { matchesPortalAccessKey, roleForLoginPortal, type LoginPortal } from "../utils/portalAccess";

const GENERIC_RESET_RESPONSE = "If an account exists for that email, password reset instructions will be sent.";
const GENERIC_VERIFY_RESPONSE = "If the account needs verification, a verification link will be sent.";

function emailUnavailable(res: Response) {
  if (canDeliverAuthEmail()) return false;
  res.status(503).json({ error: "Email delivery is not configured on the server." });
  return true;
}

async function sendVerification(email: string, token: string, next?: string) {
	const link = verificationLink(token, next);
  await sendAuthEmail(email, "Verify your SustainX email", `Verify your email address using this link: ${link}`, link);
}

export async function register(req: Request, res: Response) {
  if (emailUnavailable(res)) return;
  const email = String(req.body.email).trim().toLowerCase();
  const users = await getCollection("User");
  if (await users.findOne({ email }, { projection: { _id: 1 } })) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  try {
    const { user, verificationToken } = await createPasswordAccount({
      name: req.body.name,
      email,
      password: req.body.password,
      role: "STUDENT",
    });
    await sendVerification(email, verificationToken);
    return res.status(201).json({ message: "Account created. Check your email to verify it before signing in." });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    throw error;
  }
}

export async function login(req: Request, res: Response) {
  const email = String(req.body.email).trim().toLowerCase();
  const password = String(req.body.password);
  const portal = String(req.body.portal || "STUDENT") as LoginPortal;
  const securityKey = String(req.body.securityKey || "");
  const users = await getCollection("User");
  const user = await users.findOne({ email });
  const passwordMatches = await verifyPassword(password, typeof user?.passwordHash === "string" ? user.passwordHash : undefined);

  if (!user || !passwordMatches) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (user.status === "SUSPENDED") return res.status(403).json({ error: "This account is disabled." });
  if (user.role !== roleForLoginPortal(portal) || !matchesPortalAccessKey(portal, securityKey)) {
    return res.status(403).json({ error: "This account cannot use the selected sign-in option." });
  }
  if (user.emailVerified !== true) return res.status(403).json({ error: "Verify your email before signing in." });
  if (emailUnavailable(res)) return;

  const code = createLoginOtp();
  const { token: challengeId, tokenHash: challengeHash } = createOneTimeToken();
  const otpHash = hashLoginOtp(challengeId, code);
  const expiresAt = new Date(Date.now() + LOGIN_OTP_TTL_MS);

  await users.updateOne(
    { _id: user._id },
    {
      $set: {
        loginChallengeHash: challengeHash,
        loginOtpHash: otpHash,
        loginOtpExpiresAt: expiresAt,
        loginOtpAttempts: 0,
        loginOtpIssuedAt: new Date(),
      },
    }
  );

  try {
    await sendAuthEmail(
      email,
      "Your SustainX sign-in code",
      `Your SustainX sign-in code is ${code}. It expires in 10 minutes. If you did not try to sign in, you can ignore this email.`,
      ""
    );
  } catch (error) {
    await users.updateOne(
      { _id: user._id, loginChallengeHash: challengeHash },
      { $unset: { loginChallengeHash: "", loginOtpHash: "", loginOtpExpiresAt: "", loginOtpAttempts: "", loginOtpIssuedAt: "" } }
    );
    throw error;
  }

  return res.status(202).json({
    twoFactorRequired: true,
    challengeId,
    expiresInSeconds: LOGIN_OTP_TTL_MS / 1000,
    message: "We sent a sign-in code to your email address.",
  });
}

export async function verifyLoginCode(req: Request, res: Response) {
  const email = String(req.body.email).trim().toLowerCase();
  const challengeId = String(req.body.challengeId);
  const code = String(req.body.code);
  const challengeHash = hashOneTimeToken(challengeId);
  const users = await getCollection("User");
  const now = new Date();
  const user = await users.findOne({
    email,
    emailVerified: true,
    status: { $ne: "SUSPENDED" },
    loginChallengeHash: challengeHash,
    loginOtpExpiresAt: { $gt: now },
    loginOtpAttempts: { $lt: LOGIN_OTP_MAX_ATTEMPTS },
  });

  if (!user || typeof user.loginOtpHash !== "string" || !loginOtpMatches(challengeId, code, user.loginOtpHash)) {
    if (user) {
      await users.updateOne(
        {
          _id: user._id,
          loginChallengeHash: challengeHash,
          loginOtpExpiresAt: { $gt: now },
          loginOtpAttempts: { $lt: LOGIN_OTP_MAX_ATTEMPTS },
        },
        { $inc: { loginOtpAttempts: 1 } }
      );
    }
    return res.status(400).json({ error: "Invalid or expired sign-in code." });
  }

  const consumed = await users.updateOne(
    {
      _id: user._id,
      emailVerified: true,
      status: { $ne: "SUSPENDED" },
      loginChallengeHash: challengeHash,
      loginOtpHash: user.loginOtpHash,
      loginOtpExpiresAt: { $gt: now },
      loginOtpAttempts: { $lt: LOGIN_OTP_MAX_ATTEMPTS },
    },
    {
      $unset: {
        loginChallengeHash: "",
        loginOtpHash: "",
        loginOtpExpiresAt: "",
        loginOtpAttempts: "",
        loginOtpIssuedAt: "",
      },
    }
  );

  if (!consumed.modifiedCount) return res.status(400).json({ error: "Invalid or expired sign-in code." });

  const token = signToken({ id: String(user._id), version: Number(user.tokenVersion ?? 0) });
  return res.json({
    token,
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      impactPoints: user.impactPoints,
      emailVerified: true,
    },
  });
}

export async function verifyEmail(req: Request, res: Response) {
  const tokenHash = hashOneTimeToken(String(req.body.token));
  const result = await (await getCollection("User")).updateOne(
    { verificationTokenHash: tokenHash, verificationTokenExpiresAt: { $gt: new Date() } },
    {
      $set: { emailVerified: true, emailVerifiedAt: new Date() },
      $unset: { verificationTokenHash: "", verificationTokenExpiresAt: "" },
    }
  );
  if (!result.modifiedCount) return res.status(400).json({ error: "This verification link is invalid or expired." });
  return res.json({ message: "Email verified. You can now sign in, or request a password reset if you still need to set one." });
}

export async function resendVerification(req: Request, res: Response) {
  if (emailUnavailable(res)) return;
  const email = String(req.body.email).trim().toLowerCase();
  const users = await getCollection("User");
  const user = await users.findOne({ email, emailVerified: { $ne: true } });
  if (user) {
    const { token, tokenHash } = createOneTimeToken();
    await users.updateOne(
      { _id: user._id, emailVerified: { $ne: true } },
      { $set: { verificationTokenHash: tokenHash, verificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } }
    );
    try {
      await sendVerification(email, token, typeof req.body.next === "string" ? req.body.next : undefined);
    } catch (error) {
      console.error("Unable to send verification email.", error);
    }
  }
  return res.status(202).json({ message: GENERIC_VERIFY_RESPONSE });
}

export async function forgotPassword(req: Request, res: Response) {
  if (emailUnavailable(res)) return;
  const email = String(req.body.email).trim().toLowerCase();
  const users = await getCollection("User");
  const user = await users.findOne({ email, emailVerified: true, status: { $ne: "SUSPENDED" } });

  if (user) {
    const { token, tokenHash } = createOneTimeToken();
    await users.updateOne(
      { _id: user._id },
      { $set: { passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000) } }
    );
    const link = passwordResetLink(token);
    try {
      await sendAuthEmail(email, "Reset your SustainX password", `Reset your password using this link. It expires in one hour: ${link}`, link);
    } catch (error) {
      console.error("Unable to send password reset email.", error);
    }
  }

  return res.status(202).json({ message: GENERIC_RESET_RESPONSE });
}

export async function resetPassword(req: Request, res: Response) {
  const tokenHash = hashOneTimeToken(String(req.body.token));
  const passwordHash = await hashPassword(String(req.body.password));
  const result = await (await getCollection("User")).updateOne(
    { passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: { $gt: new Date() }, emailVerified: true },
    {
      $set: { passwordHash, passwordChangedAt: new Date() },
      $inc: { tokenVersion: 1 },
      $unset: { passwordResetTokenHash: "", passwordResetTokenExpiresAt: "" },
    }
  );
  if (!result.modifiedCount) return res.status(400).json({ error: "This password reset link is invalid or expired." });
  return res.json({ message: "Password reset. You can sign in with your new password." });
}

export async function logout(req: Request, res: Response) {
  if (req.authToken) await revokeToken(req.authToken);
  return res.status(204).send();
}

export async function me(req: Request, res: Response) {
  const user = await (await getCollection("User")).findOne(
    { _id: req.user!.id },
    { projection: { name: 1, email: 1, role: 1, impactPoints: 1, emailVerified: 1 } }
  );
  return res.json(user ? toApiDocument(user) : null);
}

export async function createAdminAccount(req: Request, res: Response) {
  if (emailUnavailable(res)) return;
  const email = String(req.body.email).trim().toLowerCase();
  const users = await getCollection("User");
  if (await users.findOne({ email }, { projection: { _id: 1 } })) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  try {
    const { user, verificationToken } = await createPasswordAccount({
      name: req.body.name,
      email,
      password: req.body.password,
      role: req.body.role,
    });
    await sendVerification(email, verificationToken);
    await recordAdminAction(req.user!.id, "USER_CREATED", "USER", String(user._id), `Created ${user.role.toLowerCase()} account.`);
    return res.status(201).json({
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      points: 0,
      activities: 0,
      status: user.status,
      emailVerified: false,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    throw error;
  }
}
