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

/** False when the frontend runs in a plain browser (`npm run dev`). */
export const inTauri = "__TAURI_INTERNALS__" in window;

const FILTERS = [{ name: "PhysPy", extensions: ["ppy", "py"] }];

export const runCell = (source: string, path: string | null, cellIndex: number) =>
  invoke<CellOutput>("run_cell", { source, path, cellIndex });

export const resetSession = () => invoke<void>("reset_session");

export const runCode = (source: string, path: string | null) =>
  invoke<RunOutput>("run_code", { source, path });

export const transpile = (source: string) => invoke<string>("transpile", { source });

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
