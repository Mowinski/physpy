import { describe, expect, it } from "vitest";
import {
  findVariableAtOffset,
  findVariableDefinition,
  findVariableOccurrences,
  getExportedNamesInCell,
  scanIdentifiers,
  validateVariableName,
} from "../src/refactor";

describe("refactor", () => {
  it("scans plain, Greek, and accented identifiers while ignoring comments, strings, units, and \\const{}", () => {
    const src = [
      "# comment with \\rho_0 and x",
      's = "string with \\rho_0" + f"val: {\\rho_0 + x}"',
      "export const \\rho_0 = 1000.0 [kg/m^3]",
      "v = (2 * \\const{g} * h) + obj.attr + func(kw=\\rho_0)",
      "\\bar{u}_a = \\rho_0 * 2 + \\i",
    ].join("\n");

    const tokens = scanIdentifiers(src);
    const varNames = tokens.filter((t) => !t.isAttr && !t.isKwarg && !t.inUnit).map((t) => t.name);

    expect(varNames).toContain("s");
    expect(varNames).toContain("\\rho_0");
    expect(varNames).toContain("x");
    expect(varNames).toContain("v");
    expect(varNames).toContain("h");
    expect(varNames).toContain("obj");
    expect(varNames).toContain("func");
    expect(varNames).toContain("\\bar{u}_a");

    // Unit identifiers like kg, m should have inUnit = true
    const unitTokens = tokens.filter((t) => t.inUnit).map((t) => t.name);
    expect(unitTokens).toEqual(expect.arrayContaining(["kg", "m"]));

    // Attribute and kwarg flags
    expect(tokens.find((t) => t.name === "attr")?.isAttr).toBe(true);
    expect(tokens.find((t) => t.name === "kw")?.isKwarg).toBe(true);
  });

  it("finds variable at cursor offset and all occurrences", () => {
    const src = "\\alpha_0 = 10\ny = \\alpha_0 + 2 * \\alpha_0\n";
    const firstIdx = src.indexOf("\\alpha_0");
    expect(findVariableAtOffset(src, firstIdx + 3)).toBe("\\alpha_0");

    const occs = findVariableOccurrences(src, "\\alpha_0");
    expect(occs).toHaveLength(3);
    expect(occs.map((o) => src.slice(o.from, o.to))).toEqual([
      "\\alpha_0",
      "\\alpha_0",
      "\\alpha_0",
    ]);
  });

  it("validates variable names for refactoring", () => {
    expect(validateVariableName("  velocity_1 ")).toEqual({ ok: true, name: "velocity_1" });
    expect(validateVariableName("\\omega_0")).toEqual({ ok: true, name: "\\omega_0" });
    expect(validateVariableName("\\bar{u}_a")).toEqual({ ok: true, name: "\\bar{u}_a" });

    expect(validateVariableName("").ok).toBe(false);
    expect(validateVariableName("123bad").ok).toBe(false);
    expect(validateVariableName("def").ok).toBe(false);
    expect(validateVariableName("export").ok).toBe(false);
    expect(validateVariableName("\\i").ok).toBe(false);
  });

  it("finds definition sites for assignments, defs, classes, loops, and imports", () => {
    const src = [
      "export import numpy as np",
      "export const \\rho_0 = 1000",
      "def calc(x):",
      "    for item in items:",
      "        pass",
      "res = calc(\\rho_0)",
    ].join("\n");

    const defNp = findVariableDefinition(src, "np");
    expect(defNp).not.toBeNull();
    expect(src.slice(defNp!.from, defNp!.to)).toBe("np");

    const defRho = findVariableDefinition(src, "\\rho_0");
    expect(defRho).not.toBeNull();
    expect(defRho!.from).toBe(src.indexOf("\\rho_0"));

    const defCalc = findVariableDefinition(src, "calc");
    expect(defCalc).not.toBeNull();
    expect(defCalc!.from).toBe(src.indexOf("calc"));

    const defItem = findVariableDefinition(src, "item");
    expect(defItem).not.toBeNull();

    const defRes = findVariableDefinition(src, "res");
    expect(defRes).not.toBeNull();

    expect(findVariableDefinition(src, "nonexistent")).toBeNull();
  });

  it("collects all exported names in a cell", () => {
    const src = [
      "export import numpy as np, sys",
      "export from math import sqrt, pi as PI",
      "export const \\rho_0 = 1000",
      "export a, b = 1, 2",
      "export def my_fn(x):",
      "    return x",
      "export class MyModel:",
      "    pass",
    ].join("\n");

    const exported = getExportedNamesInCell(src);
    expect([...exported]).toEqual(
      expect.arrayContaining(["np", "sys", "sqrt", "PI", "\\rho_0", "a", "b", "my_fn", "MyModel"]),
    );
  });
});
