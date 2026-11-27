import { describe, expect, it } from "vitest";
import { varNameToLatex } from "../src/editor/symbols";
import {
  extractVariableDescriptions,
  splitCodeAndComment,
  updateVariableDescriptionInSource,
} from "../src/variableDescriptions";

describe("variableDescriptions", () => {
  it("splits code and trailing comments while ignoring # inside strings", () => {
    expect(splitCodeAndComment('m_0 = 24.51 g  # masa piknometru')).toEqual({
      code: "m_0 = 24.51 g  ",
      comment: "masa piknometru",
    });

    expect(splitCodeAndComment('color = "#ff00aa"')).toEqual({
      code: 'color = "#ff00aa"',
      comment: null,
    });

    expect(splitCodeAndComment("label = 'item #1'  # opis etykiety")).toEqual({
      code: "label = 'item #1'  ",
      comment: "opis etykiety",
    });
  });

  it("extracts inline descriptions from regular, const, and export assignments", () => {
    const src = [
      "m_0 = 24.51 g  # masa piknometru",
      "const m_1 = 74.12 g  # masa naczynia z wodą",
      "export m_2 = 10.0 kg  # masa próbki",
      "export const g = 9.81 m/s^2  # przyspieszenie ziemskie",
      "const export V_0 = 50 ml  # objętość nominalna",
    ].join("\n");

    const map = extractVariableDescriptions(src);
    expect(map.get("m_0")).toBe("masa piknometru");
    expect(map.get("m_1")).toBe("masa naczynia z wodą");
    expect(map.get("m_2")).toBe("masa próbki");
    expect(map.get("g")).toBe("przyspieszenie ziemskie");
    expect(map.get("V_0")).toBe("objętość nominalna");
  });

  it("supports comment lines immediately above a definition and ignores cell headers", () => {
    const src = [
      "# %% Pomiary",
      "# @desc: masa suchego naczynia",
      "m_0 = 12.3 g",
      "",
      "# zwykły komentarz opisowy",
      "m_1 = 45.6 g",
      "",
      "# komentarz oddzielony pustą linią",
      "",
      "m_2 = 78.9 g",
    ].join("\n");

    const map = extractVariableDescriptions(src);
    expect(map.get("m_0")).toBe("masa suchego naczynia");
    expect(map.get("m_1")).toBe("zwykły komentarz opisowy");
    expect(map.get("m_2")).toBeUndefined();
  });

  it("normalizes LaTeX symbol identifiers so both raw and Python names resolve", () => {
    const src = "\\rho_w = 998.2 kg/m^3  # gęstość wody w 20°C";
    const map = extractVariableDescriptions(src);
    expect(map.get("\\rho_w")).toBe("gęstość wody w 20°C");
    expect(map.get("ρ_w")).toBe("gęstość wody w 20°C");
  });

  it("updates, adds, and clears variable descriptions in source code", () => {
    const src = [
      "const \\m_0 = 18.285 [g]",
      "const \\m_1 = 28.475 [g]  # stary opis",
      "# @desc: stary opis nad linią",
      "export rho = 1.0",
    ].join("\n");

    const addRes = updateVariableDescriptionInSource(src, "\\m_0", "masa piknometru");
    expect(addRes.changed).toBe(true);
    expect(addRes.updated).toContain("const \\m_0 = 18.285 [g]  # masa piknometru");

    const editRes = updateVariableDescriptionInSource(addRes.updated, "\\m_1", "masa z wodą");
    expect(editRes.changed).toBe(true);
    expect(editRes.updated).toContain("const \\m_1 = 28.475 [g]  # masa z wodą");

    const clearRes = updateVariableDescriptionInSource(editRes.updated, "rho", "");
    expect(clearRes.changed).toBe(true);
    expect(clearRes.updated).not.toContain("@desc");
    expect(clearRes.updated).toContain("export rho = 1.0");
  });

  it("converts LaTeX/subscripted variable names for KaTeX tooltip rendering", () => {
    expect(varNameToLatex("\\m_0")).toBe("m_{0}");
    expect(varNameToLatex("\\rho_w")).toBe("\\rho_{w}");
    expect(varNameToLatex("u_T")).toBe("u_{T}");
    expect(varNameToLatex("temperature")).toBeNull();
  });
});
