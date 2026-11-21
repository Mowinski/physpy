import { expect, test, type Page } from "@playwright/test";

const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function installTauriMock(page: Page) {
  await page.addInitScript((samplePng) => {
    const files: Record<string, string> = {
      "/workspace/demo.ppy": [
        "# %% [markdown] Intro Notes",
        "# ## Physical Model",
        "# Formula: $\\Delta p = \\rho_0 g h$",
        "",
        "# %% Constants",
        "export import numpy as np",
        "export const \\rho_0 = 1000.0 [kg/m^3]",
        "export const g = 9.81 [m/s^2]",
        "h = 12.5 [m]",
        "p = (\\rho_0 * g * h).to('kPa')",
        "print(f'Hydrostatic pressure: {p:.2f}')",
        "",
        "# %% Matrices & Plot",
        "export \\sigma_x = [0, 1; 1, 0]",
        "M = [1, 2; 3, 4]",
        "plot plt",
      ].join("\n"),
      "/workspace/data.csv": "Time,Voltage,Current\n0.1,2.5,0.05\n0.2,3.1,0.06\n0.3,1.8,0.04\n",
      "/workspace/paper.tex":
        "\\documentclass{article}\n\\begin{document}\n\\section{Experiment}\n$E = mc^2$\n\\end{document}\n",
      "/workspace/imported.ipynb": JSON.stringify({
        nbformat: 4,
        cells: [
          { cell_type: "markdown", source: ["# Jupyter Imported Lab\n", "Test note"] },
          { cell_type: "code", source: ["import numpy as np\n", "x = 42\n"] },
          { cell_type: "code", source: ["print(x)\n", "plt.show()\n"] },
        ],
      }),
    };

    const binaryFiles: Record<string, number[]> = {
      "/workspace/figure.png": [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1,
        13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ],
    };

    let activePython = "/workspace/.venv/bin/python3";
    let sessionExports: Record<string, string> = {};
    let debugStep = 0;

    const defaultConfig = {
      font_family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      font_size: 14.5,
      matrix_font_size: 135,
      line_numbers: true,
      format_on_save: true,
      indent_type: "spaces",
      tab_size: 4,
      python_path: "",
      startup_dir: "/workspace",
      startup_mode: "demo",
      startup_file: "",
      auto_save: "off",
      auto_save_delay: 1000,
      ai_provider: "gemini",
      ai_model: "gemini-3.8-flash",
      ai_api_key: "test-key",
      ai_system_prompt: "",
      resolved_startup_dir: "/workspace",
      global_config_path: "/Users/test/.physpy/config.yaml",
      workspace_config_path: "/workspace/.physpy-config.yaml",
    };

    (window as any).__MOCK_FILES__ = files;
    (window as any).__MOCK_CALLS__ = [];

    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (_cb: any) => 1,
      unregisterCallback: () => {},
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string, args: any = {}) => {
        (window as any).__MOCK_CALLS__.push({ cmd, args });

        if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten") {
          return 1;
        }
        if (cmd === "plugin:dialog|save") {
          return args?.options?.defaultPath || "/workspace/exported.html";
        }
        if (cmd === "plugin:dialog|open") {
          return "/workspace/demo.ppy";
        }
        if (cmd === "load_config") {
          return { ...defaultConfig };
        }
        if (cmd === "read_config_scope") {
          return {
            scope: args.scope || "global",
            file_path:
              args.scope === "workspace"
                ? "/workspace/.physpy-config.yaml"
                : "/Users/test/.physpy/config.yaml",
            exists: true,
            raw_yaml: "font_size: 14.5\nline_numbers: true\n",
            parsed: { ...defaultConfig },
            effective: { ...defaultConfig },
          };
        }
        if (cmd === "save_config_scope") {
          return {
            scope: args.scope || "global",
            file_path:
              args.scope === "workspace"
                ? "/workspace/.physpy-config.yaml"
                : "/Users/test/.physpy/config.yaml",
            exists: true,
            raw_yaml: args.rawYaml || "",
            parsed: { ...defaultConfig },
            effective: { ...defaultConfig },
          };
        }
        if (cmd === "initial_root_dir") {
          return "/workspace";
        }
        if (cmd === "list_dir") {
          const dir = args.path || "/workspace";
          const items = Object.keys(files)
            .concat(Object.keys(binaryFiles))
            .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
            .map((p) => ({
              name: p.split("/").pop()!,
              path: p,
              is_dir: false,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return items;
        }
        if (cmd === "read_file") {
          if (args.path in files) return files[args.path];
          throw new Error(`File not found: ${args.path}`);
        }
        if (cmd === "read_binary_file") {
          const key = args.path in binaryFiles ? args.path : `/workspace/${args.path}`;
          if (key in binaryFiles) return binaryFiles[key];
          throw new Error(`Binary file not found: ${args.path}`);
        }
        if (cmd === "write_file") {
          files[args.path] = args.contents;
          return null;
        }
        if (cmd === "write_binary_file") {
          binaryFiles[args.path] = args.bytes;
          return null;
        }
        if (cmd === "create_dir") {
          return null;
        }
        if (cmd === "rename_path") {
          if (args.from in files) {
            files[args.to] = files[args.from];
            delete files[args.from];
          }
          return null;
        }
        if (cmd === "delete_path") {
          delete files[args.path];
          return null;
        }
        if (cmd === "list_python_interpreters") {
          return {
            current: activePython,
            interpreters: [
              {
                path: "/workspace/.venv/bin/python3",
                version: "3.13.5",
                label: "Python 3.13.5 (venv)",
              },
              {
                path: "/opt/homebrew/bin/python3",
                version: "3.12.4",
                label: "Python 3.12.4 (Homebrew)",
              },
            ],
          };
        }
        if (cmd === "set_python_interpreter" || cmd === "set_file_interpreter") {
          activePython = args.path || args.pythonPath || activePython;
          return {
            path: activePython,
            version: "3.13.5",
            label: "Python 3.13.5 (venv)",
          };
        }
        if (cmd === "get_file_interpreter") {
          return null;
        }
        if (cmd === "reset_session") {
          sessionExports = {};
          return null;
        }
        if (cmd === "run_cell") {
          const src: string = args.source || "";
          const newlyExported: Record<string, string> = {};
          if (src.includes("\\rho_0")) {
            newlyExported["ρ_0"] = "1000.0 kg/m³";
          }
          if (src.includes("export const g")) {
            newlyExported["g"] = "9.81 m/s²";
          }
          if (src.includes("\\omega_0")) {
            newlyExported["ω_0"] = "2.215 1/s";
            newlyExported["T"] = "2.84 s";
          }
          if (src.includes("\\sigma_x")) {
            newlyExported["σ_x"] = "array([[0, 1], [1, 0]])";
          }
          Object.assign(sessionExports, newlyExported);

          const hasPlot = /\bplot\s+/.test(src);
          const hasTable = /\btable\s+/.test(src);
          const hasMatrix = src.includes("commutator") || src.includes("[1, 2; 3, 4]");

          return {
            stdout: "Hydrostatic pressure: 122.62 kPa\nFormula check: $E = mc^2$\n",
            stderr: "",
            code: 0,
            exported: newlyExported,
            all_exports: { ...sessionExports },
            plots: hasPlot ? [samplePng] : [],
            plot_meta: hasPlot
              ? [
                  {
                    plot_id: "plot_1",
                    svg: "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='60'></svg>",
                    pdf: samplePng,
                    axes: [
                      {
                        left: 0.1,
                        right: 0.9,
                        top: 0.1,
                        bottom: 0.9,
                        xlim: [0, 12],
                        ylim: [-1, 1],
                        xscale: "linear",
                        yscale: "linear",
                        xlabel: "t [s]",
                        ylabel: "θ [rad]",
                        title: "Damped Pendulum",
                        grid: true,
                        legend: true,
                        fontsize: 10,
                        series: [{ target: "ax.lines[0]", name: "Line 1", label: "θ(t)" }],
                      },
                    ],
                  },
                ]
              : [],
            latex: hasMatrix ? "\\begin{pmatrix}0 & 2\\\\-2 & 0\\end{pmatrix}" : null,
            tables: hasTable
              ? [
                  {
                    index_name: "#",
                    columns: [
                      { name: "Material", unit: null, is_numeric: false },
                      { name: "a", unit: "mm", is_numeric: true },
                    ],
                    rows: [{ index: "0", cells: ["Brass", "9.885 ± 0.033"] }],
                    total_rows: 1,
                    truncated: false,
                    raw_text: "0  Brass  9.885",
                  },
                ]
              : [],
            non_table_stdout: "Hydrostatic pressure: 122.62 kPa\n",
          };
        }
        if (cmd === "inspect_variable") {
          return {
            name: args.name,
            type: "Quantity",
            value: sessionExports[args.name] || "1000.0 kg/m³",
          };
        }
        if (cmd === "check_plot_available") {
          return true;
        }
        if (cmd === "eval_plot_code") {
          return {
            ok: true,
            code: 0,
            stdout: "",
            stderr: "",
            png: samplePng,
            history: [args.source],
            plot_meta: {
              plot_id: args.plotId,
              svg: "<svg></svg>",
              pdf: samplePng,
              axes: [
                {
                  left: 0.1,
                  right: 0.9,
                  top: 0.1,
                  bottom: 0.9,
                  xlim: [0, 12],
                  ylim: [-1, 1],
                  xscale: "linear",
                  yscale: "linear",
                  xlabel: "t [s]",
                  ylabel: "θ [rad]",
                  title: "Updated REPL Title",
                  grid: true,
                  legend: true,
                  fontsize: 10,
                  series: [],
                },
              ],
            },
          };
        }
        if (cmd === "reset_plot") {
          return {
            ok: true,
            code: 0,
            stdout: "",
            stderr: "",
            png: samplePng,
            history: [],
            plot_meta: null,
          };
        }
        if (cmd === "debug_start_cell") {
          debugStep = 1;
          return {
            ok: true,
            event: "paused",
            line: 1,
            filename: "demo.ppy#cell-1",
            cell_index: args.cellIndex || 1,
            locals: { h: "12.5 m" },
          };
        }
        if (cmd === "debug_action") {
          if (args.action === "stop" || args.action === "continue" || debugStep >= 2) {
            return {
              ok: true,
              event: "finished",
              result: {
                stdout: "Debug finished output\n",
                stderr: "",
                code: 0,
                exported: { g: "9.81 m/s²" },
                all_exports: { g: "9.81 m/s²" },
                plots: [],
                tables: [],
                latex: null,
              },
            };
          }
          debugStep++;
          return {
            ok: true,
            event: "paused",
            line: 2,
            filename: "demo.ppy#cell-1",
            cell_index: 1,
            locals: { h: "12.5 m", p: "122.62 kPa" },
          };
        }
        if (cmd === "transpile") {
          return "# Transpiled Python code\nρ_0 = __physpy_unit__(1000.0, 'kg/m^3')\n";
        }
        if (cmd === "format_cells") {
          return args.cells;
        }
        if (cmd === "complete_python") {
          return [{ label: "linspace", kind: "function", detail: "(start, stop, num=50)" }];
        }
        if (cmd === "signature_python") {
          return {
            name: "np.linspace",
            signature: "(start, stop, num=50)",
            params: [
              { name: "start", label: "start" },
              { name: "stop", label: "stop" },
              { name: "num", label: "num=50" },
            ],
            doc: "Return evenly spaced numbers.",
          };
        }
        if (cmd === "ai_assist") {
          return {
            code: "v_end = np.sqrt(2 * g * h)\nprint(v_end)\n",
            explanation: "Calculated terminal velocity from free fall.",
            model: "gemini-3.8-flash",
            input_tokens: 50,
            output_tokens: 20,
            total_tokens: 70,
          };
        }
        if (cmd === "ai_chat") {
          return {
            reply: "Here is the requested formula: $$E_k = \\frac{1}{2} m v^2$$\n```python\nE_k = 0.5 * m * v^2\n```",
            model: "gemini-3.8-flash",
            input_tokens: 60,
            output_tokens: 30,
            total_tokens: 90,
          };
        }
        if (cmd === "list_ai_models") {
          return [
            { id: "gemini-3.8-flash", display_name: "Gemini 3.8 Flash" },
            { id: "gemini-2.5-pro", display_name: "Gemini 2.5 Pro" },
          ];
        }
        if (cmd === "build_latex") {
          return {
            success: true,
            code: 0,
            log: "[pdflatex] Output written on paper.pdf (1 page).\n",
            pdf_path: null,
            resolved_target: "/workspace/paper.tex",
          };
        }
        if (cmd === "compute_relative_path") {
          return String(args.targetPath || "").replace("/workspace/", "");
        }
        return null;
      },
    };
  }, SAMPLE_PNG_B64);
}

test.describe("PhysPy E2E Application Suite", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.goto("/");
  });

  test("1. Loads demo notebook with Markdown + KaTeX math, code cells, outline, and file explorer", async ({
    page,
  }) => {
    // Verify cells loaded from demo.ppy
    const cells = page.locator(".cell-card");
    await expect(cells).toHaveCount(5);

    // First cell is Markdown rendered with KaTeX
    const firstCell = cells.first();
    await expect(firstCell.locator(".cell-md-preview")).toBeVisible();
    await expect(firstCell.locator(".cell-md-preview .katex").first()).toBeVisible();

    // Outline section shows all cells + markdown headings (6 items)
    await expect(page.locator("#outline-list .outline-item")).toHaveCount(6);

    // File tree lists workspace files
    await expect(page.locator("#file-tree")).toContainText("demo.ppy");
    await expect(page.locator("#file-tree")).toContainText("data.csv");
    await expect(page.locator("#file-tree")).toContainText("paper.tex");
    await expect(page.locator("#file-tree")).toContainText("imported.ipynb");
  });

  test("2. Executes single cell & Run All, displays stdout with KaTeX, exported bar, matrices, and plots", async ({
    page,
  }) => {
    // Run All cells
    await page.locator("#btn-run-all").click();

    // Cell 2 should display stdout and exported variables bar
    const cell2 = page.locator(".cell-card").nth(1);
    await expect(cell2.locator(".cell-output-wrap")).toBeVisible();
    await expect(cell2.locator(".cell-output")).toContainText("Hydrostatic pressure: 122.62 kPa");
    await expect(cell2.locator(".cell-exported")).toContainText("exported");

    // Expand exported variables bar
    await cell2.locator(".cell-exported-summary").click();
    await expect(cell2.locator(".cell-exported-table")).toBeVisible();

    // Cell 4 (Matrices) renders KaTeX matrix output
    const cell4 = page.locator(".cell-card").nth(3);
    await expect(cell4.locator(".cell-latex-output .katex")).toBeVisible();

    // Cell 5 (Plot) renders matplotlib plot image
    const cell5 = page.locator(".cell-card").nth(4);
    const plotImg = cell5.locator("img.cell-plot");
    await expect(plotImg).toBeVisible();

    // Clicking the plot opens the Plot Lightbox & Figure REPL
    await plotImg.click();
    await expect(page.locator("#plot-lightbox-dialog")).toBeVisible();
    await expect(page.locator("#plot-qc-title")).toHaveValue("Damped Pendulum");

    // Pin plot from lightbox
    await page.locator("#btn-lb-pin").click();
    await expect(page.locator("#pinned-plots-bar")).toBeVisible();
    await expect(page.locator("#pinned-plots-count")).toHaveText("1");

    // Close lightbox
    await page.locator("#btn-lb-close").click();
    await expect(page.locator("#plot-lightbox-dialog")).toBeHidden();
  });

  test("3. Interactive Step Debugger pauses on lines, displays locals, steps over, and finishes", async ({
    page,
  }) => {
    const codeCell = page.locator(".cell-card").nth(1);
    await codeCell.locator(".cell-btn.debug").click();

    // Debug bar should become visible with line number and local variables
    const debugBar = codeCell.locator(".cell-debug-bar");
    await expect(debugBar).toBeVisible();
    await expect(codeCell.locator(".debug-locals-preview")).toContainText("h");
    await expect(codeCell.locator(".debug-locals-preview")).toContainText("12.5 m");

    // Step Over
    await debugBar.locator('button[title*="Step Over"]').click();
    await expect(codeCell.locator(".debug-locals-preview")).toContainText("122.62 kPa");

    // Continue to finish debugging
    await debugBar.locator('button[title*="Continue"]').click();
    await expect(debugBar).toBeHidden();
    await expect(codeCell.locator(".cell-output")).toContainText("Debug finished output");
  });

  test("4. Variables & Warnings Drawer, Variable Inspector modal, and Generated Python preview pane", async ({
    page,
  }) => {
    // Run All so runtime values populate
    await page.locator("#btn-run-all").click();

    // Toggle Variables Drawer
    await page.locator("#btn-variables").click();
    const drawer = page.locator("#variables-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.locator("#variables-tbody")).toContainText("g");
    await expect(page.locator("#variables-tbody")).toContainText("9.81 m/s²");

    // Switch to Warnings tab in drawer
    await page.locator("#tab-drawer-warnings").click();
    await expect(page.locator("#drawer-pane-warnings")).toBeVisible();

    // Switch back to Variables tab and sort by Defined In
    await page.locator("#tab-drawer-variables").click();
    await page.locator("#vars-sort-defined").click();

    // Toggle Generated Python code pane
    await page.locator("#btn-python").click();
    await expect(page.locator("#python-pane")).toBeVisible();
    await expect(page.locator("#python-pane")).toContainText("__physpy_unit__");
  });

  test("5. Visual Matrix Builder modal and Static HTML Export modal", async ({ page }) => {
    // Open Matrix Builder modal
    await page.locator("#btn-insert-matrix").click();
    const matrixModal = page.locator("#matrix-dialog");
    await expect(matrixModal).toBeVisible();

    // Choose 3x3 preset and assign variable name
    await matrixModal.locator('.matrix-preset-btn[data-r="3"][data-c="3"]').click();
    await expect(page.locator("#matrix-inputs-grid input")).toHaveCount(9);
    await page.locator("#matrix-var-name").fill("A_mat");
    await expect(page.locator("#matrix-preview-render .katex")).toBeVisible();

    // Insert matrix into active cell
    await page.locator("#btn-submit-matrix").click();
    await expect(matrixModal).toBeHidden();

    // Open Static HTML Export dialog via keyboard shortcut Shift+Cmd+E / menu action
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", metaKey: true, shiftKey: true, bubbles: true }),
      );
    });
    const exportDialog = page.locator("#export-html-dialog");
    await expect(exportDialog).toBeVisible();
    await page.locator("#export-html-doc-title").fill("E2E Physics Report");
    await page.locator("#btn-export-Deselect-all, #btn-export-deselect-all").click();
    await page.locator("#btn-export-select-all").click();
    await page.locator("#btn-confirm-export-html").click();
    await expect(exportDialog).toBeHidden();
  });

  test("6. Tabs management, CSV Spreadsheet Editor, LaTeX Editor, Image Preview, and .ipynb Importer", async ({
    page,
  }) => {
    // 1. Open CSV file from sidebar
    await page.locator("#file-tree .tree-item", { hasText: "data.csv" }).click();
    await expect(page.locator("#csv-view")).toBeVisible();
    await expect(page.locator("#csv-view .csv-stats")).toHaveText("3 rows × 3 cols");
    await expect(page.locator("#csv-view table.csv-table")).toContainText("Voltage");

    // Add row in CSV table mode
    await page.locator("#csv-view button", { hasText: "+ Row" }).click();
    await expect(page.locator("#csv-view .csv-stats")).toHaveText("4 rows × 3 cols");

    // Switch CSV to raw Text mode
    await page.locator("#csv-view .csv-mode-btn", { hasText: "Text" }).click();
    await expect(page.locator("#csv-view .csv-text-container")).toBeVisible();

    // 2. Open LaTeX file from sidebar
    await page.locator("#file-tree .tree-item", { hasText: "paper.tex" }).click();
    await expect(page.locator("#latex-view")).toBeVisible();
    await expect(page.locator("#latex-view .cm-content")).toContainText("\\section{Experiment}");

    // Trigger LaTeX PDF Build
    await page.locator("#latex-view button", { hasText: "▶ Build PDF" }).click();
    await expect(page.locator("#latex-view .latex-build-badge")).toContainText("✓ Built");

    // 3. Open Image file from sidebar
    await page.locator("#file-tree .tree-item", { hasText: "figure.png" }).click();
    await expect(page.locator("#image-view")).toBeVisible();
    await expect(page.locator("#image-view .image-view-title")).toContainText("figure.png");

    // 4. Click .ipynb file in sidebar to open Jupyter Notebook Importer modal
    await page.locator("#file-tree .tree-item", { hasText: "imported.ipynb" }).click();
    const ipynbModal = page.locator("#ipynb-dialog");
    await expect(ipynbModal).toBeVisible();
    await expect(page.locator("#ipynb-preview")).toContainText("# %% [markdown] Jupyter Imported Lab");
    await expect(page.locator("#ipynb-preview")).toContainText("export x = 42");
    await expect(page.locator("#ipynb-preview")).toContainText("plot plt");
    await page.locator("#btn-save-ipynb").click();
    await expect(ipynbModal).toBeHidden();
  });

  test("7. Global Find & Replace across cells, AI Chat sidebar, Cell AI Assistant, Python Selector, and Settings tab", async ({
    page,
  }) => {
    // 1. Global Find & Replace (Cmd+F)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
    });
    const findBar = page.locator("#global-find-bar");
    await expect(findBar).toBeVisible();
    await page.locator("#global-find-input").fill("Hydrostatic");
    await expect(page.locator("#global-find-status")).not.toHaveText("0 / 0");
    await page.locator("#btn-find-close").click();
    await expect(findBar).toBeHidden();

    // 2. Cell inline AI Assistant
    const firstCodeCell = page.locator(".cell-card").nth(1);
    await firstCodeCell.locator(".cell-btn.ai").click();
    await expect(firstCodeCell.locator(".cell-ai-wrap")).toBeVisible();
    await firstCodeCell.locator(".cell-ai-input").fill("Compute terminal velocity");
    await firstCodeCell.locator(".cell-ai-generate").click();
    await expect(firstCodeCell.locator(".cell-ai-preview")).toContainText("v_end = np.sqrt(2 * g * h)");

    // 3. AI Chat Sidebar
    await page.locator("#btn-ai-chat").click();
    const aiPane = page.locator("#ai-chat-pane");
    await expect(aiPane).toBeVisible();
    await page.locator("#ai-chat-input").fill("Give me kinetic energy formula");
    await page.locator("#btn-ai-chat-send").click();
    await expect(page.locator("#ai-chat-messages")).toContainText("E_k = 0.5 * m * v^2");

    // Insert AI code block directly as a new notebook cell
    await page.locator("#ai-chat-messages .ai-chat-code-btn", { hasText: "+ Cell" }).click();
    await expect(page.locator(".cell-card")).toHaveCount(6);

    // 4. Python Interpreter Selector Modal
    await page.locator("#btn-interpreter").click();
    await expect(page.locator("#python-dialog")).toBeVisible();
    await expect(page.locator("#python-list")).toContainText("Python 3.13.5 (venv)");
    await page.locator('#python-dialog button[value="cancel"]').click();

    // 5. Settings Tab (Cmd+,)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    });
    await expect(page.locator("#settings-view")).toBeVisible();
    await expect(page.locator("#cfg-font-size")).toHaveValue("14.5");
    await page.locator("#btn-cfg-scope-workspace").click();
    await expect(page.locator("#cfg-file-path")).toContainText(".physpy-config.yaml");
  });
});
