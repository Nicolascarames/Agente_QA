import { describe, it, expect } from "vitest";
import path from "node:path";
import { assertSafeRelativePath } from "./assertSafeRelativePath.js";

describe("assertSafeRelativePath", () => {
  it("allows a normal relative path inside the base directory", () => {
    expect(() => assertSafeRelativePath("/tmp/project", "tests/test_login.py")).not.toThrow();
  });

  it("rejects a path that escapes the base directory via ..", () => {
    expect(() => assertSafeRelativePath("/tmp/project", "../../etc/passwd")).toThrow(/no permitida/);
  });

  it("rejects an absolute path pointing outside the base directory", () => {
    const absolute = path.resolve("/tmp/somewhere-else/evil.py");
    expect(() => assertSafeRelativePath("/tmp/project", absolute)).toThrow(/no permitida/);
  });
});
