import { describe, expect, it } from "vitest";
import { toRelativePath } from "../src/pathUtils";

describe("toRelativePath", () => {
  it("computes relative path for a file inside the base directory", () => {
    expect(
      toRelativePath("/Users/kamil/Projects/physpy", "/Users/kamil/Projects/physpy/examples/demo.ppy"),
    ).toBe("examples/demo.ppy");
  });

  it("handles trailing slashes on rootDir", () => {
    expect(
      toRelativePath("/Users/kamil/Projects/physpy/", "/Users/kamil/Projects/physpy/main.tex"),
    ).toBe("main.tex");
  });

  it("returns '.' when target equals rootDir", () => {
    expect(toRelativePath("/Users/kamil/Projects/physpy", "/Users/kamil/Projects/physpy")).toBe(".");
  });

  it("uses '..' when target is outside rootDir on the same drive", () => {
    expect(
      toRelativePath("/Users/kamil/Projects/physpy", "/Users/kamil/Projects/other/notes.md"),
    ).toBe("../other/notes.md");
  });

  it("normalizes Windows backslashes and keeps different drives absolute", () => {
    expect(toRelativePath("C:\\work\\proj", "C:\\work\\proj\\src\\main.py")).toBe("src/main.py");
    expect(toRelativePath("C:\\work\\proj", "D:\\data\\file.csv")).toBe("D:\\data\\file.csv");
  });
});
