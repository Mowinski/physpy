import { randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onRequest, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";

initializeApp();

const REGION = "us-central1";
const HOSTING_ORIGIN = "https://physpy-307b4.web.app";
const MAX_REPORT_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_FREE_MAX_REPORTS = 10;

interface UserProfile {
  plan: "free" | "pro";
  maxReports: number;
  reportsCount: number;
  email?: string;
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
    return {
      plan: data.plan === "pro" ? "pro" : "free",
      maxReports: typeof data.maxReports === "number" ? data.maxReports : DEFAULT_FREE_MAX_REPORTS,
      reportsCount: typeof data.reportsCount === "number" ? data.reportsCount : 0,
      email: data.email ?? email,
    };
  }

  const profile: UserProfile = {
    plan: "free",
    maxReports: DEFAULT_FREE_MAX_REPORTS,
    reportsCount: 0,
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
