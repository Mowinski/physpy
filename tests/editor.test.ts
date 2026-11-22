import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  PHYSICAL_CONSTANTS,
  SYMBOLS,
  accentToLatex,
  getAllConstants,
  getConstantOverrides,
  getCustomConstants,
  getEffectiveConstant,
  isValidAccentSymbol,
  isValidConstantName,
  isValidSymbol,
  replaceSymbolsInIdent,
  resolveAccentSymbolIdent,
  resolveSymbolIdent,
  setConstantOverrides,
  setCustomConstants,
  toLatex,
} from "../src/editor/symbols";
import { findMatrixLiterals } from "../src/editor/matrixConceal";
import { findActiveCallAt } from "../src/editor/pythonAssist";

describe("editor symbols, matrices, and call site detection", () => {
  describe("symbols.ts", () => {
    it("loads shared symbol and physical constant tables", () => {
      expect(SYMBOLS.rho).toBe("ρ");
      expect(SYMBOLS.Omega).toBe("Ω");
      expect(PHYSICAL_CONSTANTS.g.unit).toBe("m/s^2");
      expect(PHYSICAL_CONSTANTS.c.value).toBe(299792458);
      expect(Object.keys(ACCENTS)).toContain("bar");
    });

    it("validates plain and accented symbols", () => {
      expect(isValidSymbol("rho", "_0")).toBe(true);
      expect(isValidSymbol("i", "")).toBe(true);
      expect(isValidSymbol("m", "_0")).toBe(true);
      expect(isValidSymbol("unknownsym", "")).toBe(false);

      expect(isValidAccentSymbol("bar", "u")).toBe(true);
      expect(isValidAccentSymbol("hat", "\\theta")).toBe(true);
      expect(isValidAccentSymbol("bar", "\\i")).toBe(false);
      expect(isValidAccentSymbol("unknown_acc", "u")).toBe(false);
    });

    it("converts symbols and accents to KaTeX LaTeX strings", () => {
      expect(toLatex("i", "")).toBe("i");
      expect(toLatex("rho", "_0")).toBe("\\rho_{0}");
      expect(toLatex("v", "_max")).toBe("v_{\\mathrm{max}}");

      expect(accentToLatex("bar", "u", "_a")).toBe("\\bar{u}_{a}");
      expect(accentToLatex("overline", "czas", "")).toBe("\\overline{\\text{czas}}");
      expect(accentToLatex("prime", "t", "_0")).toBe("{t}'_{0}");
      expect(accentToLatex("dprime", "\\theta", "")).toBe("{\\theta}''");
    });

    it("resolves symbols to normalized Python identifiers", () => {
      expect(resolveSymbolIdent("i", "")).toBe("1j");
      expect(resolveSymbolIdent("rho", "_0")).toBe("ρ_0");
      expect(resolveSymbolIdent("m", "_0")).toBe("m_0");
      expect(resolveAccentSymbolIdent("bar", "u", "_a")).toBe("u\u0304_a".normalize("NFKC"));
      expect(replaceSymbolsInIdent("\\rho_0 + \\bar{u}_a")).toBe(
        `ρ_0 + ${"u\u0304_a".normalize("NFKC")}`,
      );
    });

    it("supports overriding and resetting physical constants", () => {
      setConstantOverrides({ g: 9.8123, unknown_const: 42, c: Number.NaN });
      expect(getConstantOverrides()).toEqual({ g: 9.8123 });

      const gEff = getEffectiveConstant("g");
      expect(gEff?.value).toBe(9.8123);
      expect(gEff?.defaultValue).toBe(9.80665);
      expect(gEff?.overridden).toBe(true);

      const cEff = getEffectiveConstant("c");
      expect(cEff?.value).toBe(299792458);
      expect(cEff?.overridden).toBe(false);

      setConstantOverrides({});
      expect(getEffectiveConstant("g")?.value).toBe(9.80665);
      expect(getEffectiveConstant("g")?.overridden).toBe(false);
    });

    it("supports defining, overriding, and clearing custom constants", () => {
      expect(isValidConstantName("rho_w")).toBe(true);
      expect(isValidConstantName("bad name")).toBe(false);

      setCustomConstants({
        rho_w: { value: 1000, unit: "kg/m^3", latex: "rho_w", label: "water density" },
        g: { value: 1, unit: "m/s^2", latex: "g", label: "should not shadow" },
      });
      expect(Object.keys(getCustomConstants())).toEqual(["rho_w"]);
      expect(getAllConstants().rho_w?.value).toBe(1000);

      const eff = getEffectiveConstant("rho_w");
      expect(eff?.isCustom).toBe(true);
      expect(eff?.value).toBe(1000);

      setConstantOverrides({ rho_w: 1025 });
      expect(getEffectiveConstant("rho_w")?.value).toBe(1025);
      expect(getEffectiveConstant("rho_w")?.overridden).toBe(true);

      setConstantOverrides({});
      setCustomConstants({});
      expect(getEffectiveConstant("rho_w")).toBeUndefined();
    });
  });

  describe("matrixConceal (findMatrixLiterals)", () => {
    it("detects 2D semicolon-separated matrix literals while ignoring normal lists, strings, and comments", () => {
      const code = [
        "# [1, 2; 3, 4] in comment",
        's = "[1, 2; 3, 4]"',
        "normal_list = [1, 2, 3]",
        "M1 = [1, 2; 3, 4]",
        "M2 = [\n  a[0], a[1];\n  b[0], b[1]\n]",
      ].join("\n");

      const found = findMatrixLiterals(code);
      expect(found).toHaveLength(2);
      expect(found[0].raw).toBe("[1, 2; 3, 4]");
      expect(found[1].raw).toContain("a[0], a[1];");
    });
  });

  describe("pythonAssist (findActiveCallAt)", () => {
    it("identifies active function call, positional argument index, and keyword argument name", () => {
      const code = "res = np.linspace(0.0, 10.0, num=50";
      const pos0 = code.indexOf("0.0") + 1;
      const pos1 = code.indexOf("10.0") + 1;
      const pos2 = code.length;

      expect(findActiveCallAt(code, pos0)).toEqual({
        expr: "np.linspace",
        parenPos: code.indexOf("("),
        argIndex: 0,
        kwargName: null,
      });

      expect(findActiveCallAt(code, pos1)).toEqual({
        expr: "np.linspace",
        parenPos: code.indexOf("("),
        argIndex: 1,
        kwargName: null,
      });

      expect(findActiveCallAt(code, pos2)).toEqual({
        expr: "np.linspace",
        parenPos: code.indexOf("("),
        argIndex: 2,
        kwargName: "num",
      });
    });

    it("returns null outside calls or after control-flow keywords like if (...)", () => {
      expect(findActiveCallAt("if (x > 0", 8)).toBeNull();
      expect(findActiveCallAt("x = (1 + 2)", 11)).toBeNull();
    });
  });
});
