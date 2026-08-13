import { describe, it, expect } from "vitest";
import { resolveOpenCommand } from "./openFile.js";

describe("resolveOpenCommand", () => {
  it("opens a markdown file with 'code' when inside a VSCode terminal", () => {
    expect(resolveOpenCommand("markdown", "/tmp/summary.md", { TERM_PROGRAM: "vscode" }, "linux")).toEqual({
      command: "code",
      args: ["/tmp/summary.md"],
    });
  });

  it("opens an html file with the OS opener even inside a VSCode terminal", () => {
    expect(resolveOpenCommand("html", "/tmp/report.html", { TERM_PROGRAM: "vscode" }, "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/report.html"],
    });
  });

  it("opens a markdown file with the OS opener when not inside VSCode", () => {
    expect(resolveOpenCommand("markdown", "/tmp/summary.md", {}, "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/summary.md"],
    });
  });

  it('uses \'cmd /c start "" <path>\' on win32', () => {
    expect(resolveOpenCommand("html", "C:\\tmp\\report.html", {}, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "C:\\tmp\\report.html"],
    });
  });

  it("uses 'open' on darwin", () => {
    expect(resolveOpenCommand("html", "/tmp/report.html", {}, "darwin")).toEqual({
      command: "open",
      args: ["/tmp/report.html"],
    });
  });

  it("uses 'xdg-open' on any other platform", () => {
    expect(resolveOpenCommand("markdown", "/tmp/summary.md", {}, "freebsd")).toEqual({
      command: "xdg-open",
      args: ["/tmp/summary.md"],
    });
  });
});
