/** Thin wrapper around Tauri commands (see src-tauri/src/lib.rs). */
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface RunOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface CellOutput {
  stdout: string;
  stderr: string;
  code: number;
  exported: Record<string, string>;
  all_exports: Record<string, string>;
  plots: string[];
}

export interface DirEntryItem {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface PythonInterpreterInfo {
  path: string;
  version: string;
  label: string;
}

export interface PythonListResponse {
  current: string;
  interpreters: PythonInterpreterInfo[];
}

/** False when the frontend runs in a plain browser (`npm run dev`). */
export const inTauri = "__TAURI_INTERNALS__" in window;

const FILTERS = [{ name: "PhysPy", extensions: ["ppy", "py"] }];

export const runCell = (
  source: string,
  path: string | null,
  cwd: string | null,
  cellIndex: number,
  docSource: string,
) => invoke<CellOutput>("run_cell", { source, path, cwd, cellIndex, docSource });

export const resetSession = () => invoke<void>("reset_session");

export const runCode = (source: string, path: string | null) =>
  invoke<RunOutput>("run_code", { source, path });

export const transpile = (source: string) => invoke<string>("transpile", { source });

export const initialRootDir = () => invoke<string>("initial_root_dir");

export const listDir = (path: string) => invoke<DirEntryItem[]>("list_dir", { path });

export const readFileByPath = (path: string) => invoke<string>("read_file", { path });

export const readBinaryFile = (path: string, baseDir: string | null) =>
  invoke<number[]>("read_binary_file", { path, baseDir });

export async function pickMediaFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "PDF & Images",
        extensions: ["pdf", "png", "jpg", "jpeg", "webp", "svg", "gif"],
      },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

export const writeFileByPath = (path: string, contents: string) =>
  invoke<void>("write_file", { path, contents });

export const createDir = (path: string) => invoke<void>("create_dir", { path });

export const renamePath = (from: string, to: string) => invoke<void>("rename_path", { from, to });

export const deletePath = (path: string) => invoke<void>("delete_path", { path });

export const listPythonInterpreters = (workspaceDir: string | null) =>
  invoke<PythonListResponse>("list_python_interpreters", { workspaceDir });

export const setPythonInterpreter = (path: string) =>
  invoke<PythonInterpreterInfo>("set_python_interpreter", { path });

export async function pickPythonBinary(): Promise<string | null> {
  const file = await open({ multiple: false, directory: false });
  return typeof file === "string" ? file : null;
}

export async function pickFolder(): Promise<string | null> {
  const dir = await open({ multiple: false, directory: true });
  return typeof dir === "string" ? dir : null;
}

export async function openFile(): Promise<{ path: string; contents: string } | null> {
  const path = await open({ multiple: false, directory: false, filters: FILTERS });
  if (typeof path !== "string") return null;
  return { path, contents: await invoke<string>("read_file", { path }) };
}

export async function saveFile(contents: string, path: string | null): Promise<string | null> {
  const target = path ?? (await save({ filters: FILTERS, defaultPath: "untitled.ppy" }));
  if (!target) return null;
  await invoke("write_file", { path: target, contents });
  return target;
}

export async function pickSavePpyPath(defaultPath: string): Promise<string | null> {
  const target = await save({
    filters: [{ name: "PhysPy Notebook", extensions: ["ppy"] }],
    defaultPath,
  });
  return typeof target === "string" ? target : null;
}

export async function savePlotPng(base64Png: string, defaultPath: string): Promise<string | null> {
  const target = await save({
    filters: [{ name: "PNG Image", extensions: ["png"] }],
    defaultPath,
  });
  if (typeof target !== "string" || !target) return null;
  const binStr = atob(base64Png);
  const bytes = new Array<number>(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  await invoke("write_binary_file", { path: target, bytes });
  return target;
}
