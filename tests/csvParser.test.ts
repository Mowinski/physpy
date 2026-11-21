import { describe, expect, it } from "vitest";
import { detectCsvDelimiter, parseCsv, serializeCsv } from "../src/csvParser";

describe("csvParser", () => {
  describe("detectCsvDelimiter", () => {
    it("detects comma by default for empty or comma-separated text", () => {
      expect(detectCsvDelimiter("")).toBe(",");
      expect(detectCsvDelimiter("a,b,c\n1,2,3\n4,5,6")).toBe(",");
    });

    it("detects semicolon when columns are consistently separated by semicolons", () => {
      expect(detectCsvDelimiter("t;U;I\n0.1;2,5;0,05\n0.2;3,1;0,06")).toBe(";");
    });

    it("detects tab from .tsv filename hint or tab-separated content", () => {
      expect(detectCsvDelimiter("a,b,c", "measurements.tsv")).toBe("\t");
      expect(detectCsvDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    });

    it("ignores delimiters inside double-quoted fields", () => {
      const csv = 'name;notes\n"a, b, c";10\n"d, e, f";20';
      expect(detectCsvDelimiter(csv)).toBe(";");
    });
  });

  describe("parseCsv", () => {
    it("returns a 1x1 empty cell for empty input", () => {
      expect(parseCsv("", ",")).toEqual([[""]]);
    });

    it("strips UTF-8 BOM if present", () => {
      expect(parseCsv("\uFEFFx,y\n1,2\n", ",")).toEqual([
        ["x", "y"],
        ["1", "2"],
      ]);
    });

    it("parses quoted fields with escaped quotes, commas, and multiline text", () => {
      const text = 'id,label,comment\r\n1,"a, ""quoted""",line1\nline2\r\n2,plain,"multi\nline"';
      const rows = parseCsv(text, ",");
      expect(rows).toEqual([
        ["id", "label", "comment"],
        ["1", 'a, "quoted"', "line1"],
        ["line2", "", ""],
        ["2", "plain", "multi\nline"],
      ]);
    });

    it("pads ragged rows to create a rectangular 2D array", () => {
      const rows = parseCsv("a,b,c\n1\n2,3", ",");
      expect(rows).toEqual([
        ["a", "b", "c"],
        ["1", "", ""],
        ["2", "3", ""],
      ]);
    });
  });

  describe("serializeCsv", () => {
    it("serializes 2D rows and escapes special characters per RFC 4180", () => {
      const rows = [
        ["col1", "col2", "col3"],
        ["plain", "with,comma", 'with "quotes"'],
        ["multiline\ncell", "normal", ""],
      ];
      const serialized = serializeCsv(rows, ",", "\n", true);
      expect(serialized).toBe(
        'col1,col2,col3\nplain,"with,comma","with ""quotes"""\n"multiline\ncell",normal,\n',
      );
      expect(parseCsv(serialized, ",")).toEqual(rows);
    });

    it("respects custom lineEnding and trailingNewline=false", () => {
      const rows = [
        ["a", "b"],
        ["1", "2"],
      ];
      expect(serializeCsv(rows, ";", "\r\n", false)).toBe("a;b\r\n1;2");
      expect(serializeCsv([], ",")).toBe("");
    });
  });
});
