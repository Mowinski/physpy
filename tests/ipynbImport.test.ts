import { describe, expect, it } from "vitest";
import { convertIpynbToPpy } from "../src/ipynbImport";

describe("ipynbImport (convertIpynbToPpy)", () => {
  it("returns error on invalid JSON or missing cells array", () => {
    const badJson = convertIpynbToPpy("{not valid json");
    expect(badJson.ok).toBe(false);
    expect(badJson.error).toContain("Invalid JSON");

    const noCells = convertIpynbToPpy(JSON.stringify({ nbformat: 4 }));
    expect(noCells.ok).toBe(false);
    expect(noCells.error).toContain('missing top-level "cells" array');
  });

  it("converts markdown and code cells, auto-exports cross-cell variables/imports/functions, and rewrites plt.show()", () => {
    const notebook = {
      nbformat: 4,
      cells: [
        {
          cell_type: "markdown",
          source: ["# Oscillations Lab\n", "Formula: $T = 2\\pi \\sqrt{L/g}$"],
        },
        {
          cell_type: "code",
          source: [
            "%matplotlib inline\n",
            "!pip install pint\n",
            "import numpy as np\n",
            "from math import sqrt, pi as PI\n",
            "def compute_period(length):\n",
            "    return 2 * PI * sqrt(length / g)\n",
            "g = 9.81\n",
            "local_only = 123\n",
          ],
        },
        {
          cell_type: "code",
          source: [
            "import matplotlib.pyplot as plt\n",
            "L = np.linspace(0.5, 2.0, 10)\n",
            "T = compute_period(1.0)\n",
            "plt.plot(L, L * g)\n",
            "plt.show()  # display figure\n",
          ],
        },
      ],
    };

    const res = convertIpynbToPpy(JSON.stringify(notebook), {
      autoExport: true,
      convertPltShow: true,
    });

    expect(res.ok).toBe(true);
    expect(res.markdownCellCount).toBe(1);
    expect(res.codeCellCount).toBe(2);
    expect(res.convertedPlotsCount).toBe(1);
    expect(res.autoExportedNames).toEqual(expect.arrayContaining(["np", "compute_period", "g"]));
    expect(res.autoExportedNames).not.toContain("local_only");

    expect(res.ppySource).toContain("# %% [markdown] Oscillations Lab");
    expect(res.ppySource).toContain("# # Oscillations Lab");
    expect(res.ppySource).toContain("# [Jupyter magic] %matplotlib inline");
    expect(res.ppySource).toContain("# [Jupyter magic] !pip install pint");
    expect(res.ppySource).toContain("export import numpy as np");
    expect(res.ppySource).toContain("export def compute_period(length):");
    expect(res.ppySource).toContain("export g = 9.81");
    expect(res.ppySource).not.toContain("export local_only");
    expect(res.ppySource).toContain("plot plt  # display figure");
  });

  it("can disable autoExport and convertPltShow options", () => {
    const notebook = {
      cells: [
        { cell_type: "code", source: "x = 10\n" },
        { cell_type: "code", source: "print(x)\nplt.show()\n" },
      ],
    };
    const res = convertIpynbToPpy(JSON.stringify(notebook), {
      autoExport: false,
      convertPltShow: false,
    });
    expect(res.ok).toBe(true);
    expect(res.autoExportedNames).toEqual([]);
    expect(res.convertedPlotsCount).toBe(0);
    expect(res.ppySource).not.toContain("export x = 10");
    expect(res.ppySource).toContain("plt.show()");
  });

  it("creates a default empty Cell 1 when notebook has no non-empty cells", () => {
    const res = convertIpynbToPpy(JSON.stringify({ cells: [] }));
    expect(res.ok).toBe(true);
    expect(res.ppySource.trim()).toBe("# %% Cell 1");
  });
});
