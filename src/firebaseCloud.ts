import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || "",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: env.VITE_FIREBASE_APP_ID || "",
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || "",
};

export function isCloudConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

function getFunctionsBaseUrl(): string {
  const override = env.VITE_FIREBASE_FUNCTIONS_URL;
  if (override) return override.replace(/\/+$/, "");
  if (firebaseConfig.projectId) {
    return `https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net`;
  }
  return "";
}

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (!isCloudConfigured()) {
    throw new Error(
      "PhysPy Cloud is not configured in this build (missing VITE_FIREBASE_* environment variables).",
    );
  }
  if (!appInstance) {
    appInstance = initializeApp(firebaseConfig);
    if (typeof window !== "undefined") {
      isAnalyticsSupported()
        .then((supported) => {
          if (supported && appInstance) {
            getAnalytics(appInstance);
          }
        })
        .catch(() => {});
    }
  }
  return appInstance;
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(getFirebaseApp());
  }
  return authInstance;
}

export function onCloudAuthChange(callback: (user: User | null) => void): () => void {
  if (!isCloudConfigured()) {
    return () => {};
  }
  return onAuthStateChanged(getFirebaseAuth(), callback);
}

export function getCurrentCloudUser(): User | null {
  if (!isCloudConfigured()) return null;
  return getFirebaseAuth().currentUser;
}

export async function signInCloud(email: string, password: string): Promise<User> {
  const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
  return cred.user;
}

export async function signUpCloud(email: string, password: string): Promise<User> {
  const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
  return cred.user;
}

export async function signOutCloud(): Promise<void> {
  if (!isCloudConfigured()) return;
  await signOut(getFirebaseAuth());
}

async function getRequiredIdToken(): Promise<string> {
  const user = getFirebaseAuth().currentUser;
  if (!user) {
    throw new Error("Sign in to PhysPy Cloud first.");
  }
  return user.getIdToken();
}

export interface PublishReportRequest {
  html: string;
  title: string;
  notebookName: string;
  reportId?: string;
}

export interface PublishReportResponse {
  reportId: string;
  url: string;
  title: string;
  notebookName: string;
  sizeBytes: number;
  isUpdate: boolean;
}

export interface PublishedReportItem {
  reportId: string;
  url: string;
  title: string;
  notebookName: string;
  sizeBytes: number;
  views: number;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ListReportsResponse {
  plan: "free" | "pro";
  maxReports: number;
  reportsCount: number;
  reports: PublishedReportItem[];
}

async function parseErrorResponse(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message || data.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function publishHtmlReport(
  payload: PublishReportRequest,
): Promise<PublishReportResponse> {
  const token = await getRequiredIdToken();
  const res = await fetch(`${getFunctionsBaseUrl()}/publishReport`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }
  return (await res.json()) as PublishReportResponse;
}

export async function listMyPublishedReports(): Promise<ListReportsResponse> {
  const token = await getRequiredIdToken();
  const res = await fetch(`${getFunctionsBaseUrl()}/listMyReports`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }
  return (await res.json()) as ListReportsResponse;
}

export async function deletePublishedReport(reportId: string): Promise<void> {
  const token = await getRequiredIdToken();
  const res = await fetch(
    `${getFunctionsBaseUrl()}/deleteReport?reportId=${encodeURIComponent(reportId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }
}

export interface CloudAccountStatus {
  uid: string;
  email: string | null;
  plan: "free" | "pro";
  maxReports: number;
  reportsCount: number;
  aiDailyLimit: number;
  aiRequestsToday: number;
  aiTokensTotal: number;
}

export async function getCloudAccountStatus(): Promise<CloudAccountStatus> {
  const token = await getRequiredIdToken();
  const res = await fetch(`${getFunctionsBaseUrl()}/getCloudAccountStatus`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }
  return (await res.json()) as CloudAccountStatus;
}

export interface CloudAiAssistParams {
  prompt: string;
  cellSource: string;
  contextBefore: string;
  exports: Record<string, string>;
  extraSystemPrompt?: string;
  model?: string;
}

export interface CloudAiAssistResult {
  code: string;
  explanation?: string;
  model?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
}

export async function callCloudAiAssist(
  params: CloudAiAssistParams,
): Promise<CloudAiAssistResult> {
  const token = await getRequiredIdToken();
  const res = await fetch(`${getFunctionsBaseUrl()}/cloudAiAssist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }
  return (await res.json()) as CloudAiAssistResult;
}

export interface CloudAiChatParams {
  messages: { role: string; content: string }[];
  notebookSource: string;
  exports: Record<string, string>;
  extraSystemPrompt?: string;
  model?: string;
}

export interface CloudAiChatResult {
  reply: string;
  model?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
}

export async function callCloudAiChat(
  params: CloudAiChatParams,
): Promise<CloudAiChatResult> {
  const token = await getRequiredIdToken();
  const res = await fetch(`${getFunctionsBaseUrl()}/cloudAiChat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(await parseErrorResponse(res));
  }
  return (await res.json()) as CloudAiChatResult;
}
