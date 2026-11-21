/**
 * Compute a relative path from `rootDir` to `targetPath`.
 * Normalizes both `/` and `\` separators and returns POSIX-style `/` segments.
 */
export function toRelativePath(rootDir: string, targetPath: string): string {
  const normRoot = normalizePath(rootDir);
  const normTarget = normalizePath(targetPath);

  const rootDrive = extractDrivePrefix(normRoot);
  const targetDrive = extractDrivePrefix(normTarget);
  if (rootDrive !== targetDrive) {
    return targetPath;
  }

  const rootBody = normRoot.slice(rootDrive.length).replace(/^\/+/, "");
  const targetBody = normTarget.slice(targetDrive.length).replace(/^\/+/, "");

  const rootParts = rootBody ? rootBody.split("/") : [];
  const targetParts = targetBody ? targetBody.split("/") : [];

  let common = 0;
  while (
    common < rootParts.length &&
    common < targetParts.length &&
    rootParts[common] === targetParts[common]
  ) {
    common++;
  }

  const ups = new Array<string>(rootParts.length - common).fill("..");
  const rest = targetParts.slice(common);
  const joined = [...ups, ...rest].join("/");
  return joined || ".";
}

function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  if (slashed.length > 1 && !/^[A-Za-z]:\/$/.test(slashed)) {
    return slashed.replace(/\/+$/, "");
  }
  return slashed;
}

function extractDrivePrefix(p: string): string {
  const m = p.match(/^([A-Za-z]:)/);
  return m ? m[1].toUpperCase() : "";
}
