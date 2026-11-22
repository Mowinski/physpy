import { randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getRemoteConfig } from "firebase-admin/remote-config";
import { getStorage } from "firebase-admin/storage";
import { onRequest, type Request } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import type { Response } from "express";

initializeApp();

const geminiApiKeySecret = defineSecret("GEMINI_API_KEY");
const REGION = "us-central1";
const HOSTING_ORIGIN = "https://physpy-307b4.web.app";
const MAX_REPORT_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_FREE_MAX_REPORTS = 10;
const DEFAULT_FREE_AI_DAILY_LIMIT = 30;
const DEFAULT_PRO_AI_DAILY_LIMIT = 500;
const MAX_AI_INPUT_CHARS = 60_000;
const DEFAULT_CLOUD_AI_MODEL_FREE = "gemini-2.5-flash";
const DEFAULT_CLOUD_AI_MODEL_PRO = "gemini-2.5-pro";
const REMOTE_CONFIG_CACHE_TTL_MS = 60_000;

let cachedRemoteModels: { free: string; pro: string; fetchedAt: number } | null = null;

async function getCloudAiModelsFromRemoteConfig(): Promise<{ free: string; pro: string }> {
  const now = Date.now();
  if (cachedRemoteModels && now - cachedRemoteModels.fetchedAt < REMOTE_CONFIG_CACHE_TTL_MS) {
    return { free: cachedRemoteModels.free, pro: cachedRemoteModels.pro };
  }

  let free = DEFAULT_CLOUD_AI_MODEL_FREE;
  let pro = DEFAULT_CLOUD_AI_MODEL_PRO;

  try {
    const template = await getRemoteConfig().getTemplate();
    const params = template.parameters ?? {};
    const freeVal = params.ai_model_free?.defaultValue;
    const proVal = params.ai_model_pro?.defaultValue;

    if (freeVal && "value" in freeVal && typeof freeVal.value === "string" && freeVal.value.trim()) {
      free = freeVal.value.trim();
    }
    if (proVal && "value" in proVal && typeof proVal.value === "string" && proVal.value.trim()) {
      pro = proVal.value.trim();
    }
  } catch {
    // Fall back to defaults if Remote Config hasn't been initialized yet
  }

  cachedRemoteModels = { free, pro, fetchedAt: now };
  return { free, pro };
}

interface UserProfile {
  plan: "free" | "pro";
  maxReports: number;
  reportsCount: number;
  email?: string;
  aiModel?: string;
  aiDailyLimit?: number;
  aiRequestsToday?: number;
  aiQuotaDate?: string;
  aiTokensTotal?: number;
}

interface ReportDoc {
  reportId: string;
  ownerId: string;
  title: string;
  notebookName: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  views: number;
}

function generateReportId(): string {
  return randomBytes(8).toString("base64url").slice(0, 10);
}

function setCorsHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
}

async function verifyRequestAuth(req: Request): Promise<DecodedIdToken | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    return await getAuth().verifyIdToken(token);
  } catch {
    return null;
  }
}

async function ensureUserProfile(uid: string, email?: string): Promise<UserProfile> {
  const db = getFirestore();
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (snap.exists) {
    const data = snap.data() as Partial<UserProfile>;
    const plan = data.plan === "pro" ? "pro" : "free";
    const today = new Date().toISOString().slice(0, 10);
    const sameDay = data.aiQuotaDate === today;
    return {
      plan,
      maxReports: typeof data.maxReports === "number" ? data.maxReports : DEFAULT_FREE_MAX_REPORTS,
      reportsCount: typeof data.reportsCount === "number" ? data.reportsCount : 0,
      email: data.email ?? email,
      aiModel: typeof data.aiModel === "string" && data.aiModel.trim() ? data.aiModel.trim() : undefined,
      aiDailyLimit:
        typeof data.aiDailyLimit === "number"
          ? data.aiDailyLimit
          : plan === "pro"
            ? DEFAULT_PRO_AI_DAILY_LIMIT
            : DEFAULT_FREE_AI_DAILY_LIMIT,
      aiRequestsToday: sameDay && typeof data.aiRequestsToday === "number" ? data.aiRequestsToday : 0,
      aiQuotaDate: today,
      aiTokensTotal: typeof data.aiTokensTotal === "number" ? data.aiTokensTotal : 0,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const profile: UserProfile = {
    plan: "free",
    maxReports: DEFAULT_FREE_MAX_REPORTS,
    reportsCount: 0,
    aiDailyLimit: DEFAULT_FREE_AI_DAILY_LIMIT,
    aiRequestsToday: 0,
    aiQuotaDate: today,
    aiTokensTotal: 0,
    ...(email ? { email } : {}),
  };
  await userRef.set({
    ...profile,
    createdAt: FieldValue.serverTimestamp(),
  });
  return profile;
}

/**
 * Publishes or updates a static HTML report in Cloud Storage and records metadata in Firestore.
 * POST /publishReport
 * Headers: Authorization: Bearer <Firebase ID Token>
 * Body: { html: string, title?: string, notebookName?: string, reportId?: string }
 */
export const publishReport = onRequest(
  { region: REGION, invoker: "public", maxInstances: 20, memory: "512MiB" },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const decoded = await verifyRequestAuth(req);
    if (!decoded) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Valid Firebase ID token required." });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const html = typeof body.html === "string" ? body.html : "";
    if (!html.trim()) {
      res.status(400).json({ error: "INVALID_HTML", message: "Non-empty html string is required." });
      return;
    }

    const htmlBuffer = Buffer.from(html, "utf8");
    if (htmlBuffer.byteLength > MAX_REPORT_BYTES) {
      res.status(413).json({
        error: "PAYLOAD_TOO_LARGE",
        message: `Report exceeds maximum size of ${MAX_REPORT_BYTES} bytes.`,
      });
      return;
    }

    const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
    const rawNotebook = typeof body.notebookName === "string" ? body.notebookName.trim() : "";
    const title = (rawTitle || rawNotebook || "PhysPy Report").slice(0, 200);
    const notebookName = (rawNotebook || "notebook.ppy").slice(0, 200);
    const requestedReportId =
      typeof body.reportId === "string" && /^[A-Za-z0-9_-]{6,32}$/.test(body.reportId)
        ? body.reportId
        : null;

    const db = getFirestore();
    const uid = decoded.uid;
    const profile = await ensureUserProfile(uid, decoded.email);

    let reportId = requestedReportId;
    let isUpdate = false;

    if (reportId) {
      const existingSnap = await db.collection("reports").doc(reportId).get();
      if (!existingSnap.exists) {
        res.status(404).json({ error: "REPORT_NOT_FOUND", message: "Report to update not found." });
        return;
      }
      const existing = existingSnap.data() as ReportDoc;
      if (existing.ownerId !== uid) {
        res.status(403).json({ error: "FORBIDDEN", message: "You do not own this report." });
        return;
      }
      isUpdate = true;
    } else {
      if (profile.reportsCount >= profile.maxReports) {
        res.status(403).json({
          error: "QUOTA_EXCEEDED",
          message: `Report limit reached (${profile.reportsCount}/${profile.maxReports}) on ${profile.plan} plan.`,
          plan: profile.plan,
          maxReports: profile.maxReports,
          reportsCount: profile.reportsCount,
        });
        return;
      }
      reportId = generateReportId();
    }

    const storagePath = `reports/${uid}/${reportId}.html`;
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);

    await file.save(htmlBuffer, {
      resumable: false,
      contentType: "text/html; charset=utf-8",
      metadata: {
        cacheControl: "public, max-age=300",
        metadata: {
          ownerId: uid,
          reportId,
        },
      },
    });

    const reportRef = db.collection("reports").doc(reportId);
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (tx) => {
      if (isUpdate) {
        tx.update(reportRef, {
          title,
          notebookName,
          sizeBytes: htmlBuffer.byteLength,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        tx.set(reportRef, {
          reportId,
          ownerId: uid,
          title,
          notebookName,
          sizeBytes: htmlBuffer.byteLength,
          storagePath,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          views: 0,
        });
        tx.update(userRef, {
          reportsCount: FieldValue.increment(1),
        });
      }
    });

    const url = `${HOSTING_ORIGIN}/r/${reportId}`;
    res.status(200).json({
      reportId,
      url,
      title,
      notebookName,
      sizeBytes: htmlBuffer.byteLength,
      isUpdate,
    });
  },
);

/**
 * Serves a published HTML report at /r/<reportId> via Firebase Hosting rewrite.
 */
export const serveReport = onRequest(
  { region: REGION, invoker: "public", maxInstances: 40 },
  async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // Path can be "/r/abc123" (Hosting rewrite) or "/abc123" (direct function call)
    const segments = req.path.split("/").filter(Boolean);
    const reportId = segments[0] === "r" ? segments[1] : segments[0];

    if (!reportId || !/^[A-Za-z0-9_-]{6,32}$/.test(reportId)) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8").send(
        "<!doctype html><html><body><h1>404 - Report Not Found</h1></body></html>",
      );
      return;
    }

    const db = getFirestore();
    const reportRef = db.collection("reports").doc(reportId);
    const snap = await reportRef.get();
    if (!snap.exists) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8").send(
        "<!doctype html><html><body><h1>404 - Report Not Found</h1><p>This report does not exist or has been removed.</p></body></html>",
      );
      return;
    }

    const report = snap.data() as ReportDoc;
    const bucket = getStorage().bucket();
    const file = bucket.file(report.storagePath);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8").send(
        "<!doctype html><html><body><h1>404 - Report File Missing</h1></body></html>",
      );
      return;
    }

    const [contents] = await file.download();

    // Strict CSP: static reports need inline styles, data: images/fonts, and no scripts.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src data: https://cdn.jsdelivr.net; img-src data: https:; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none';",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");

    if (req.method === "GET") {
      // Increment views asynchronously without blocking response
      reportRef.update({ views: FieldValue.increment(1) }).catch(() => {});
      res.status(200).send(contents);
    } else {
      res.status(200).end();
    }
  },
);

/**
 * Lists published reports owned by the authenticated user along with quota info.
 * GET /listMyReports
 */
export const listMyReports = onRequest(
  { region: REGION, invoker: "public", maxInstances: 10 },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const decoded = await verifyRequestAuth(req);
    if (!decoded) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const db = getFirestore();
    const uid = decoded.uid;
    const profile = await ensureUserProfile(uid, decoded.email);

    const snap = await db
      .collection("reports")
      .where("ownerId", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const reports = snap.docs.map((doc) => {
      const d = doc.data() as ReportDoc;
      return {
        reportId: d.reportId,
        url: `${HOSTING_ORIGIN}/r/${d.reportId}`,
        title: d.title,
        notebookName: d.notebookName,
        sizeBytes: d.sizeBytes,
        views: d.views ?? 0,
        createdAt: d.createdAt?.toMillis?.() ?? null,
        updatedAt: d.updatedAt?.toMillis?.() ?? null,
      };
    });

    res.status(200).json({
      plan: profile.plan,
      maxReports: profile.maxReports,
      reportsCount: profile.reportsCount,
      reports,
    });
  },
);

/**
 * Deletes a published report owned by the authenticated user.
 * DELETE /deleteReport?reportId=<id> (or POST with { reportId })
 */
export const deleteReport = onRequest(
  { region: REGION, invoker: "public", maxInstances: 10 },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "DELETE" && req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const decoded = await verifyRequestAuth(req);
    if (!decoded) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const reportId =
      (typeof req.query.reportId === "string" ? req.query.reportId : null) ??
      (typeof body.reportId === "string" ? body.reportId : null);

    if (!reportId || !/^[A-Za-z0-9_-]{6,32}$/.test(reportId)) {
      res.status(400).json({ error: "INVALID_REPORT_ID" });
      return;
    }

    const db = getFirestore();
    const uid = decoded.uid;
    const reportRef = db.collection("reports").doc(reportId);
    const snap = await reportRef.get();

    if (!snap.exists) {
      res.status(404).json({ error: "REPORT_NOT_FOUND" });
      return;
    }

    const report = snap.data() as ReportDoc;
    if (report.ownerId !== uid) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }

    const bucket = getStorage().bucket();
    await bucket.file(report.storagePath).delete({ ignoreNotFound: true });

    const userRef = db.collection("users").doc(uid);
    await db.runTransaction(async (tx) => {
      tx.delete(reportRef);
      tx.update(userRef, {
        reportsCount: FieldValue.increment(-1),
      });
    });

    res.status(200).json({ deleted: true, reportId });
  },
);

// --- PhysPy Cloud AI Agent --------------------------------------------------

const PHYSPY_SYSTEM_PROMPT = [
  "You are the PhysPy Cloud AI assistant embedded in a Python + Physics laboratory notebook editor.",
  "PhysPy extends Python with:",
  "- Explicit units in square brackets: e.g. `g = 9.81 [m/s^2]`, `m = 2.5 [kg]`.",
  "- `export const name = value` to share constants across cells.",
  "- `print(expr)` or `$$expr$$` for LaTeX/KaTeX formatted math output, plus NumPy, SciPy, Pint, Matplotlib, and Pandas.",
  "Be concise, accurate, and prefer SI units and clean Python/PhysPy code.",
].join("\n");

async function resolveCloudAiModel(profile: UserProfile): Promise<string> {
  if (profile.aiModel) {
    return profile.aiModel;
  }
  const models = await getCloudAiModelsFromRemoteConfig();
  return profile.plan === "pro" ? models.pro : models.free;
}

interface GeminiUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

async function callGeminiApi(params: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  jsonMode?: boolean;
}): Promise<{ text: string; usage: GeminiUsage }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    params.model,
  )}:generateContent?key=${encodeURIComponent(params.apiKey)}`;

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: params.systemInstruction }] },
    contents: params.contents,
    generationConfig: {
      temperature: 0.2,
      ...(params.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Upstream Gemini API error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? "";

  const usage: GeminiUsage = {
    input_tokens: data.usageMetadata?.promptTokenCount ?? null,
    output_tokens: data.usageMetadata?.candidatesTokenCount ?? null,
    total_tokens: data.usageMetadata?.totalTokenCount ?? null,
  };

  return { text, usage };
}

async function recordAiUsage(uid: string, totalTokens: number | null): Promise<void> {
  const db = getFirestore();
  const userRef = db.collection("users").doc(uid);
  const today = new Date().toISOString().slice(0, 10);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = (snap.data() ?? {}) as Partial<UserProfile>;
    const sameDay = data.aiQuotaDate === today;
    const prevToday = sameDay && typeof data.aiRequestsToday === "number" ? data.aiRequestsToday : 0;
    tx.set(
      userRef,
      {
        aiQuotaDate: today,
        aiRequestsToday: prevToday + 1,
        aiTokensTotal: FieldValue.increment(totalTokens ?? 0),
      },
      { merge: true },
    );
  });
}

/**
 * Returns the authenticated user's cloud plan, report quota, and AI usage.
 * GET /getCloudAccountStatus
 */
export const getCloudAccountStatus = onRequest(
  { region: REGION, invoker: "public", maxInstances: 10 },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const decoded = await verifyRequestAuth(req);
    if (!decoded) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const profile = await ensureUserProfile(decoded.uid, decoded.email);
    const aiModel = await resolveCloudAiModel(profile);
    res.status(200).json({
      uid: decoded.uid,
      email: decoded.email ?? profile.email ?? null,
      plan: profile.plan,
      aiModel,
      maxReports: profile.maxReports,
      reportsCount: profile.reportsCount,
      aiDailyLimit: profile.aiDailyLimit ?? DEFAULT_FREE_AI_DAILY_LIMIT,
      aiRequestsToday: profile.aiRequestsToday ?? 0,
      aiTokensTotal: profile.aiTokensTotal ?? 0,
    });
  },
);

/**
 * Managed Cloud AI Assist for a single notebook cell.
 * POST /cloudAiAssist
 */
export const cloudAiAssist = onRequest(
  {
    region: REGION,
    invoker: "public",
    maxInstances: 20,
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [geminiApiKeySecret],
  },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const decoded = await verifyRequestAuth(req);
    if (!decoded) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Sign in to PhysPy Cloud first." });
      return;
    }

    const profile = await ensureUserProfile(decoded.uid, decoded.email);
    const dailyLimit = profile.aiDailyLimit ?? DEFAULT_FREE_AI_DAILY_LIMIT;
    const usedToday = profile.aiRequestsToday ?? 0;
    if (usedToday >= dailyLimit) {
      res.status(429).json({
        error: "AI_QUOTA_EXCEEDED",
        message: `Daily Cloud AI limit reached (${usedToday}/${dailyLimit}) on ${profile.plan} plan.`,
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const cellSource = typeof body.cellSource === "string" ? body.cellSource : "";
    const contextBefore = typeof body.contextBefore === "string" ? body.contextBefore : "";
    const extraPrompt = typeof body.extraSystemPrompt === "string" ? body.extraSystemPrompt.trim() : "";
    const exportsMap =
      body.exports && typeof body.exports === "object" ? (body.exports as Record<string, unknown>) : {};

    if (!prompt) {
      res.status(400).json({ error: "INVALID_PROMPT", message: "Prompt is required." });
      return;
    }

    const totalLen = prompt.length + cellSource.length + contextBefore.length;
    if (totalLen > MAX_AI_INPUT_CHARS) {
      res.status(413).json({
        error: "INPUT_TOO_LARGE",
        message: `Input exceeds ${MAX_AI_INPUT_CHARS} characters.`,
      });
      return;
    }

    const apiKey = geminiApiKeySecret.value();
    if (!apiKey) {
      res.status(503).json({ error: "CLOUD_AI_UNAVAILABLE", message: "Cloud AI key not configured." });
      return;
    }

    const model = await resolveCloudAiModel(profile);
    const systemInstruction = [
      PHYSPY_SYSTEM_PROMPT,
      extraPrompt ? `User instructions: ${extraPrompt}` : "",
      'Respond ONLY with a JSON object: {"code": "<updated cell code>", "explanation": "<brief 1-2 sentence explanation>"}.',
    ]
      .filter(Boolean)
      .join("\n\n");

    const exportsText = Object.entries(exportsMap)
      .slice(0, 60)
      .map(([k, v]) => `${k} = ${String(v)}`)
      .join("\n");

    const userMessage = [
      exportsText ? `Exported constants/variables:\n${exportsText}` : "",
      contextBefore ? `Previous cells context:\n${contextBefore.slice(-12000)}` : "",
      `Current cell code:\n\`\`\`python\n${cellSource}\n\`\`\``,
      `User request: ${prompt}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const { text, usage } = await callGeminiApi({
        apiKey,
        model,
        systemInstruction,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        jsonMode: true,
      });

      let parsed: { code?: string; explanation?: string } = {};
      try {
        parsed = JSON.parse(text) as { code?: string; explanation?: string };
      } catch {
        parsed = { code: text, explanation: "" };
      }

      await recordAiUsage(decoded.uid, usage.total_tokens);

      res.status(200).json({
        code: typeof parsed.code === "string" ? parsed.code : cellSource,
        explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
        model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
      });
    } catch (err) {
      res.status(502).json({
        error: "CLOUD_AI_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * Managed Cloud AI Chat for notebook-wide Q&A.
 * POST /cloudAiChat
 */
export const cloudAiChat = onRequest(
  {
    region: REGION,
    invoker: "public",
    maxInstances: 20,
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [geminiApiKeySecret],
  },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const decoded = await verifyRequestAuth(req);
    if (!decoded) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Sign in to PhysPy Cloud first." });
      return;
    }

    const profile = await ensureUserProfile(decoded.uid, decoded.email);
    const dailyLimit = profile.aiDailyLimit ?? DEFAULT_FREE_AI_DAILY_LIMIT;
    const usedToday = profile.aiRequestsToday ?? 0;
    if (usedToday >= dailyLimit) {
      res.status(429).json({
        error: "AI_QUOTA_EXCEEDED",
        message: `Daily Cloud AI limit reached (${usedToday}/${dailyLimit}) on ${profile.plan} plan.`,
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const notebookSource = typeof body.notebookSource === "string" ? body.notebookSource : "";
    const extraPrompt = typeof body.extraSystemPrompt === "string" ? body.extraSystemPrompt.trim() : "";
    const exportsMap =
      body.exports && typeof body.exports === "object" ? (body.exports as Record<string, unknown>) : {};

    const messages = rawMessages
      .filter(
        (m): m is { role: string; content: string } =>
          Boolean(m && typeof m === "object" && typeof (m as { content?: unknown }).content === "string"),
      )
      .slice(-20);

    if (messages.length === 0) {
      res.status(400).json({ error: "INVALID_MESSAGES", message: "At least one message is required." });
      return;
    }

    const totalLen =
      notebookSource.length + messages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalLen > MAX_AI_INPUT_CHARS) {
      res.status(413).json({
        error: "INPUT_TOO_LARGE",
        message: `Conversation + notebook context exceeds ${MAX_AI_INPUT_CHARS} characters.`,
      });
      return;
    }

    const apiKey = geminiApiKeySecret.value();
    if (!apiKey) {
      res.status(503).json({ error: "CLOUD_AI_UNAVAILABLE", message: "Cloud AI key not configured." });
      return;
    }

    const model = await resolveCloudAiModel(profile);
    const exportsText = Object.entries(exportsMap)
      .slice(0, 60)
      .map(([k, v]) => `${k} = ${String(v)}`)
      .join("\n");

    const systemInstruction = [
      PHYSPY_SYSTEM_PROMPT,
      extraPrompt ? `User instructions: ${extraPrompt}` : "",
      exportsText ? `Exported constants/variables:\n${exportsText}` : "",
      notebookSource ? `Current notebook source:\n\`\`\`python\n${notebookSource.slice(0, 25000)}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const contents = messages.map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content }],
    }));

    try {
      const { text, usage } = await callGeminiApi({
        apiKey,
        model,
        systemInstruction,
        contents,
      });

      await recordAiUsage(decoded.uid, usage.total_tokens);

      res.status(200).json({
        reply: text,
        model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
      });
    } catch (err) {
      res.status(502).json({
        error: "CLOUD_AI_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
